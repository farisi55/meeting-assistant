/**
 * meeting-assistant — Cloudflare Worker
 * ---------------------------------------------------------
 * Serve frontend statis (./public) + proxy ke beberapa provider LLM/STT
 * gratis sekaligus, dengan fallback otomatis kalau satu provider kena
 * limit. Key tidak pernah nyentuh browser.
 *
 *   POST /api/chat        -> LLM, fallback: OpenRouter > Groq > Mistral > SambaNova
 *   POST /api/transcribe  -> STT via Groq Whisper (satu-satunya yang gratis di daftar ini)
 *
 * Auth: Bearer token toggle via AUTH_ENABLED (client kirim
 * `Authorization: Bearer <BASIC_AUTH_TOKEN>`), plus lockout sederhana
 * (maks. 3 percobaan gagal per IP, reset otomatis setelah 15 menit lewat
 * KV TTL) begitu AUTH_KV di-bind. Tanpa binding AUTH_KV, auth tetap jalan
 * tapi tanpa proteksi brute-force.
 *
 * LOKAL (tanpa auth) — buat file .dev.vars di root project (gitignore ini):
 *   AUTH_ENABLED=false
 *   OPENROUTER_API_KEY=sk-or-xxx
 *   GROQ_API_KEY=gsk_xxx
 *   MISTRAL_API_KEY=xxx
 *   SAMBANOVA_API_KEY=xxx
 *   Lalu: wrangler dev        (persis pola .env di n8n / 9router — KV
 *   lockout otomatis pakai simulasi lokal Miniflare, tidak perlu setup
 *   tambahan untuk dev)
 *
 * LOKAL (dengan auth): AUTH_ENABLED=true + BASIC_AUTH_TOKEN=<token acak>,
 * lalu frontend ambil token yang sama dari localStorage (knowledge §5).
 *
 * PUBLIK di Cloudflare (dengan auth + lockout):
 *   wrangler kv namespace create AUTH_KV   # salin id-nya ke wrangler.toml
 *   wrangler secret put OPENROUTER_API_KEY
 *   wrangler secret put GROQ_API_KEY
 *   wrangler secret put MISTRAL_API_KEY
 *   wrangler secret put SAMBANOVA_API_KEY
 *   wrangler secret put BASIC_AUTH_TOKEN    # token acak: openssl rand -hex 32
 *   # set AUTH_ENABLED = "true" di [vars] wrangler.toml, lalu:
 *   wrangler deploy
 *
 * Kalau Cloudflare Access juga diaktifkan di Worker ini, request tanpa
 * login sudah diblokir di edge sebelum kode ini jalan sama sekali —
 * AUTH_ENABLED aman dibiarkan menyala berbarengan sebagai lapis kedua.
 */

// Semua provider di bawah OpenAI-compatible di /chat/completions, jadi
// satu request-builder dipakai untuk keempatnya. Urutan array di
// FALLBACK_ORDER = urutan coba kalau satu provider kena limit/error.
// Tambah provider baru cukup di sini — tidak perlu ubah kode lain.
const PROVIDERS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    // openrouter/free = auto-router, pilih model :free yg lagi aktif.
    // Ganti ke model :free spesifik (mis. deepseek/deepseek-chat-v3.1:free)
    // kalau butuh model yang sama tiap panggilan.
    defaultModel: 'openrouter/free',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-small-latest',
  },
  sambanova: {
    baseUrl: 'https://api.sambanova.ai/v1',
    apiKeyEnv: 'SAMBANOVA_API_KEY',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
  },
};

const FALLBACK_ORDER = ['openrouter', 'groq', 'mistral', 'sambanova'];

// Nama model & slug provider di atas berubah dari waktu ke waktu —
// cross-check di dashboard masing-masing provider sebelum deploy serius.

const MAX_AUTH_FAILURES = 3;
const LOCKOUT_TTL_SECONDS = 900; // 15 menit — auto-reset via KV TTL kalau tidak ada percobaan baru

function authRequired(env) {
  return env.AUTH_ENABLED === 'true';
}

/**
 * Fail-fast konfigurasi auth: kalau AUTH_ENABLED=true tapi ada kredensial
 * yang belum di-set, kembalikan 500 diagnostik yang menyebut NAMA var yang
 * hilang (bukan nilainya) — bukan 401 generik yang bikin bingung saat debug.
 * Mengembalikan null kalau konfigurasi lengkap atau auth memang dimatikan.
 */
function authConfigError(env) {
  if (!authRequired(env)) return null;
  const missing = ['BASIC_AUTH_TOKEN'].filter((name) => !env[name]);
  if (missing.length === 0) return null;
  return new Response(
    `Konfigurasi auth tidak lengkap: ${missing.join(', ')} belum di-set. ` +
      'Set lewat `wrangler secret put <NAMA>` (produksi) atau .dev.vars (lokal).',
    { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
}

/**
 * Bandingkan kandidat token dengan token yang benar secara constant-time
 * (crypto.subtle.timingSafeEqual) — tanpa cabang per-byte, jadi timing
 * respons tidak membocorkan isi token. Panjang dicek dulu karena API-nya
 * mewajibkan dua buffer sama panjang; panjang token acak bukan rahasia,
 * isinya yang harus tetap tertutup.
 */
function tokensMatch(candidate, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const enc = new TextEncoder();
  const a = enc.encode(candidate);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * Cek Bearer token + lockout. Mengembalikan { ok, locked }.
 * - Belum ada header Authorization sama sekali -> ok:false, locked:false
 *   (ini baru "silakan login", BUKAN percobaan gagal — supaya page load
 *   pertama tidak ikut kehitung ke lockout)
 * - Header ada tapi salah -> dihitung sebagai percobaan gagal
 * - 3x salah dari IP yang sama -> locked:true, respons berikutnya 429
 *   walau token yang dikirim sudah benar, sampai TTL habis
 */
async function checkAuth(request, env) {
  // PII-SAFE LOGGING: header Authorization dan nilai token tidak boleh
  // pernah masuk console.* — lihat CONTRIBUTING.md & knowledge §8.
  if (!authRequired(env)) return { ok: true, locked: false };

  const hasKv = !!env.AUTH_KV;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const lockKey = `authfail:${ip}`;

  const failures = hasKv ? parseInt((await env.AUTH_KV.get(lockKey)) || '0', 10) : 0;
  if (hasKv && failures >= MAX_AUTH_FAILURES) {
    return { ok: false, locked: true };
  }

  const header = request.headers.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return { ok: false, locked: false };
  }

  const correct = tokensMatch(token, env.BASIC_AUTH_TOKEN);

  if (hasKv) {
    if (correct) {
      await env.AUTH_KV.delete(lockKey); // reset setelah login berhasil
    } else {
      await env.AUTH_KV.put(lockKey, String(failures + 1), {
        expirationTtl: LOCKOUT_TTL_SECONDS,
      });
    }
  }

  return { ok: correct, locked: false };
}

function unauthorized(locked) {
  if (locked) {
    return new Response(
      `Terlalu banyak percobaan gagal. Coba lagi dalam ${LOCKOUT_TTL_SECONDS / 60} menit.`,
      {
        status: 429,
        headers: { 'Retry-After': String(LOCKOUT_TTL_SECONDS) },
      },
    );
  }
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer realm="personal-assistant"' },
  });
}

async function callProvider(id, cfg, env, body) {
  const apiKey = env[cfg.apiKeyEnv];
  if (!apiKey) return null; // provider ini belum di-set, skip diam-diam

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(id === 'openrouter'
        ? {
            'HTTP-Referer': env.PUBLIC_URL || 'https://example.workers.dev',
            'X-Title': 'meeting-assistant',
          }
        : {}),
    },
    body: JSON.stringify({
      model: body.model || cfg.defaultModel,
      messages: body.messages,
      temperature: body.temperature ?? 0.4,
      max_tokens: body.max_tokens ?? 500,
      // Non-stream supaya status tiap provider bisa dicek sebelum fallback
      // ke provider berikutnya. Streaming bisa ditambah lagi begitu kamu
      // sudah settle ke satu provider utama.
      stream: false,
    }),
  });

  return { id, res };
}

async function handleChat(request, env) {
  // PII-SAFE LOGGING: isi body (messages, transcript, konteks) tidak boleh
  // pernah masuk console.* — log hanya metadata non-PII (nama provider,
  // status code). Lihat CONTRIBUTING.md & knowledge §8.
  const body = await request.json();

  // Client boleh paksa satu provider spesifik: { "provider": "groq", ... }
  const order = body.provider ? [body.provider] : FALLBACK_ORDER;

  let lastResult = null;
  for (const id of order) {
    const cfg = PROVIDERS[id];
    if (!cfg) continue;
    const result = await callProvider(id, cfg, env, body);
    if (!result) continue; // key belum di-set untuk provider ini
    lastResult = result;
    if (result.res.ok) {
      const data = await result.res.json();
      return Response.json({ ...data, _provider: id });
    }
    // 429 / 5xx dari provider ini -> lanjut coba provider berikutnya
  }

  if (!lastResult) {
    return new Response(
      'Tidak ada provider dengan API key ter-set di environment',
      { status: 500 },
    );
  }
  // Semua provider di rantai fallback gagal — kembalikan error asli terakhir
  return new Response(lastResult.res.body, {
    status: lastResult.res.status,
    headers: {
      'Content-Type': lastResult.res.headers.get('Content-Type') || 'application/json',
    },
  });
}

async function handleTranscribe(request, env) {
  // PII-SAFE LOGGING: file audio, hasil transkrip, dan GROQ_API_KEY tidak
  // boleh pernah masuk console.* — lihat CONTRIBUTING.md & knowledge §8.
  if (!env.GROQ_API_KEY) {
    return new Response(
      'GROQ_API_KEY belum di-set (satu-satunya STT gratis di daftar provider ini)',
      { status: 500 },
    );
  }
  const incoming = await request.formData();
  const file = incoming.get('file');
  if (!file) return new Response('Field "file" wajib ada', { status: 400 });

  const forward = new FormData();
  forward.append('file', file, 'chunk.webm');
  // Cek slug model terbaru di console.groq.com/docs/models sebelum andalkan ini.
  forward.append('model', incoming.get('model') || 'whisper-large-v3-turbo');
  forward.append('language', incoming.get('language') || 'id');
  forward.append('response_format', 'json');

  const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: forward,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    },
  });
}

export default {
  async fetch(request, env) {
    // Sebelum auth & routing: konfigurasi rusak harus gagal keras (500)
    // untuk semua request, termasuk frontend statis — bukan 401 diam-diam.
    const configError = authConfigError(env);
    if (configError) return configError;

    const auth = await checkAuth(request, env);
    if (!auth.ok) return unauthorized(auth.locked);

    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChat(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/transcribe') {
      return handleTranscribe(request, env);
    }

    // Fallback ke frontend statis (index.html, app.js, ...) di ./public
    return env.ASSETS.fetch(request);
  },
};

// Diekspor hanya untuk unit test (fail-fast konfigurasi auth & perbandingan token).
export { authConfigError, tokensMatch };
