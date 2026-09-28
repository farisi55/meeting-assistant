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
 * Semua panggilan upstream dibatasi timeout eksplisit (CHAT_TIMEOUT_MS
 * default 15000, TRANSCRIBE_TIMEOUT_MS default 30000) — provider yang
 * hang di-abort dan dihitung gagal supaya rantai fallback lanjut, bukan
 * menggantung sampai WAF edge memutus. Setiap respons (termasuk statis
 * & error) dibungkus header keamanan: HSTS, X-Frame-Options,
 * X-Content-Type-Options, CSP tanpa unsafe-inline/eval.
 *
 * Auth: Bearer token toggle via AUTH_ENABLED (client kirim
 * `Authorization: Bearer <BASIC_AUTH_TOKEN>`), plus lockout sederhana
 * (maks. 3 percobaan gagal per IP, reset otomatis setelah 15 menit lewat
 * KV TTL) begitu AUTH_KV di-bind. Tanpa binding AUTH_KV, auth tetap jalan
 * tapi tanpa proteksi brute-force.
 *
 * Lingkup auth: HANYA route /api/*. Frontend statis disajikan tanpa auth
 * karena browser tidak pernah mengirim header Authorization pada
 * navigasi document (Bearer tidak punya prompt native seperti Basic) —
 * menjaga shell di sini hanya membuat halaman 401 tanpa jalan masuk.
 * Tidak ada rahasia di frontend; API tetap terlambang. Token diisi
 * lewat panel "Akses API" di UI (localStorage meeting-assistant.auth-token).
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
    defaultModel: 'openai/gpt-oss-120b',
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

// SambaNova dikeluarkan dari rantai default: free tier-nya kini menuntut
// metode pembayaran (402 PAYMENT_METHOD_REQUIRED) sehingga selalu gagal.
// PROVIDERS tetap memuatnya supaya `provider: 'sambanova'` masih bisa
// dipaksa dan rantai bisa dikembalikan setelah billing diaktifkan.
const FALLBACK_ORDER = ['openrouter', 'groq', 'mistral'];

// Nama model & slug provider di atas berubah dari waktu ke waktu —
// cross-check di dashboard masing-masing provider sebelum deploy serius.

const MAX_AUTH_FAILURES = 3;
const LOCKOUT_TTL_SECONDS = 900; // 15 menit — auto-reset via KV TTL kalau tidak ada percobaan baru

const CHAT_TIMEOUT_MS = 15_000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;

/**
 * Ambil nilai timeout dari env (bisa dioverride per deploy / per test),
 * dengan fallback ke default. Nilai non-positif atau non-angka diabaikan
 * supaya config rusak tidak mematikan timeout sama sekali.
 */
function envTimeoutMs(env, name, fallback) {
  const raw = Number(env?.[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Error internal untuk membedakan timeout dari error jaringan lain:
 * rantai fallback hanya boleh "lanjut ke provider berikutnya" untuk
 * timeout (ProviderTimeoutError); error lain tetap melesat ke atas
 * seperti perilaku lama (500 fail-fast).
 */
class ProviderTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`provider tidak merespons dalam ${timeoutMs}ms`);
    this.name = 'ProviderTimeoutError';
    this.code = 'PROVIDER_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * fetch() dengan batas waktu: AbortController + setTimeout, timer selalu
 * di-clear di finally supaya tidak bocor. Abort dari fetch (bukan dari
 * kita) dilempar ulang apa adanya — hanya timeout sendiri yang dipetakan
 * ke ProviderTimeoutError.
 */
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    // Body dibaca di sini selagi timer masih berjalan. Kalau upstream kirim
    // header lalu berhenti menghasilkan isi (model reasoning lambat),
    // abort tetap meledak -> ProviderTimeoutError, bukan dibiarin menggantung
    // tanpa batas setelah header diterima.
    const headers = new Headers(res.headers);
    // text sudah terdekompresi; header encoding/length asli tidak boleh
    // dibawa ke badan yang dibangun ulang.
    headers.delete('content-length');
    headers.delete('content-encoding');
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(nullBody ? null : text, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new ProviderTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function authRequired(env) {
  return env.AUTH_ENABLED === 'true';
}

/**
 * Pilih model Groq pengganti lewat GET /openai/v1/models ketika model
 * default-nya 404 (retired — kasus Groq 2026-08-16). Daftar /models tidak
 * memuat harga; semua model aktif dapat kuota tier gratis/developer, jadi
 * kandidat difilter: hanya yang `active`, hanya yang chat (whisper/guard/
 * tts/dsb. dibuang), preferensi model production yang dikenal, fallback ke
 * entri pertama. null = tanpa pemulihan (rantai lanjut seperti biasa).
 */
async function pickGroqReplacementModel(cfg, env) {
  let res;
  try {
    res = await fetchWithTimeout(
      `${cfg.baseUrl}/models`,
      { headers: { Authorization: `Bearer ${env[cfg.apiKeyEnv]}` } },
      envTimeoutMs(env, 'CHAT_TIMEOUT_MS', CHAT_TIMEOUT_MS),
    );
  } catch {
    return null; // timeout / network -> tanpa pemulihan
  }
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const chatIds = list
    .filter((m) => m && (m.active ?? true) !== false)
    .map((m) => (typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : ''))
    .filter((id) => id && !/whisper|guard|tts|embedding|rerank/i.test(id));
  if (!chatIds.length) return null;
  const preferred = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
  return preferred.find((p) => chatIds.includes(p) && p !== cfg.defaultModel) ?? chatIds[0];
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

/**
 * Panggil satu provider OpenAI-compatible. Mengembalikan null kalau API
 * key belum di-set (skip diam-diam), { id, res } kalau ada respons.
 * Timeout diatur CHAT_TIMEOUT_MS — hang dipetakan ke ProviderTimeoutError.
 */
async function callProvider(id, cfg, env, body) {
  const apiKey = env[cfg.apiKeyEnv];
  if (!apiKey) return null; // provider ini belum di-set, skip diam-diam

  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/chat/completions`,
    {
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
    },
    envTimeoutMs(env, 'CHAT_TIMEOUT_MS', CHAT_TIMEOUT_MS),
  );

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
  let timedOut = false; // minimal satu panggilan melebihi CHAT_TIMEOUT_MS
  for (const id of order) {
    const cfg = PROVIDERS[id];
    if (!cfg) continue;
    let result;
    try {
      result = await callProvider(id, cfg, env, body);
    } catch (err) {
      // Hanya timeout yang dianggap "provider X gagal, lanjut berikutnya";
      // error jaringan lain tetap dilempar (perilaku lama: 500 fail-fast).
      if (err instanceof ProviderTimeoutError) {
        timedOut = true;
        continue;
      }
      throw err;
    }
    if (!result) continue; // key belum di-set untuk provider ini
    // Pemulihan model Groq: model DEFAULT-nya menjawab 404 (retired) dan
    // client tidak memaksa `model` → GET /openai/v1/models sekali, pilih
    // model aktif pengganti, ulangi Groq dengan model itu. Retry hanya
    // sekali per request; kalau 404 lagi / /models gagal → perilaku persis
    // seperti tanpa pemulihan (lanjut rantai seperti biasa).
    if (id === 'groq' && result.res.status === 404 && !body.model) {
      const replacement = await pickGroqReplacementModel(cfg, env);
      if (replacement) {
        try {
          const retry = await callProvider(id, cfg, env, { ...body, model: replacement });
          if (retry) result = retry;
        } catch (err) {
          if (err instanceof ProviderTimeoutError) timedOut = true; // pakai 404 asli
          else throw err;
        }
      }
    }
    lastResult = result;
    if (result.res.ok) {
      // Body dibaca sebagai teks dulu supaya bisa dipassthrough utuh kalau
      // ternyata tidak usable (model reasoning mengisi `reasoning` dengan
      // content null, choices kosong, atau badan non-JSON).
      let rawText = null;
      let data = null;
      try {
        rawText = await result.res.text();
        data = JSON.parse(rawText);
      } catch {
        data = null;
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim() !== '') {
        return Response.json({ ...data, _provider: id });
      }
      // 200 tanpa konten usable -> provider ini dianggap gagal dan rantai
      // fallback lanjut (sejajar "hang = gagal" Task #013). Badan asli
      // disimpan sebagai lastResult agar tetap ter-passthrough utuh kalau
      // semua provider gagal — client-lah yang memunculkan error shape-nya.
      lastResult = {
        id,
        res: new Response(rawText ?? '', {
          status: result.res.status,
          headers: {
            'Content-Type': result.res.headers.get('Content-Type') || 'application/json',
          },
        }),
      };
    }
    // 429 / 5xx dari provider ini -> lanjut coba provider berikutnya
  }

  if (!lastResult) {
    // Tidak ada respons sama sekali: kalau ada yang timeout -> 504
    // (beda diagnosis dari "tidak ada key" yang tetap 500).
    if (timedOut) {
      const timeoutMs = envTimeoutMs(env, 'CHAT_TIMEOUT_MS', CHAT_TIMEOUT_MS);
      return new Response(`Semua provider LLM melebihi timeout ${timeoutMs}ms`, {
        status: 504,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response(
      'Tidak ada provider dengan API key ter-set di environment',
      { status: 500 },
    );
  }
  // Ada respons nyata terakhir — kembalikan error asli provider itu apa
  // adanya (timeout provider lain tidak menimpa status asli yang valid).
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

  let upstream;
  try {
    upstream = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: forward,
      },
      envTimeoutMs(env, 'TRANSCRIBE_TIMEOUT_MS', TRANSCRIBE_TIMEOUT_MS),
    );
  } catch (err) {
    if (err instanceof ProviderTimeoutError) {
      const timeoutMs = envTimeoutMs(env, 'TRANSCRIBE_TIMEOUT_MS', TRANSCRIBE_TIMEOUT_MS);
      return new Response(`Groq Whisper melebihi timeout ${timeoutMs}ms`, {
        status: 504,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    throw err;
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    },
  });
}

/**
 * Bungkus SETIAP respons dengan header keamanan (Phase-4 FULL gate):
 * HSTS, X-Frame-Options SAMEORIGIN, X-Content-Type-Options, dan CSP
 * tanpa 'unsafe-inline'/'unsafe-eval'. Header asli disalin dulu supaya
 * Content-Type / Retry-After / WWW-Authenticate tidak hilang; status
 * tanpa-body (204/304) tetap tanpa body.
 */
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
      "object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'",
  );
  const body = [101, 204, 205, 304].includes(response.status) ? null : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Router inti: fail-fast konfigurasi -> auth /api/* -> handler API ->
 * fallback statis. Terpisah dari pembungkus header keamanan supaya semua
 * cabang (termasuk error konfigurasi & 401) otomatis ikut dibungkus.
 */
async function routeRequest(request, env) {
  // Sebelum auth & routing: konfigurasi rusak harus gagal keras (500)
  // untuk semua request, termasuk frontend statis — bukan 401 diam-diam.
  const configError = authConfigError(env);
  if (configError) return configError;

  const url = new URL(request.url);

  // Auth hanya untuk /api/* — lihat komentar header file ini: shell
  // statis harus tetap termuat saat AUTH_ENABLED=true, karena browser
  // tidak pernah menempelkan header Authorization ke document request.
  // Fail-fast konfigurasi di atas TETAP berlaku untuk semua path
  // (miscofig deployment harus tetap gagal keras, bukan 401 diam-diam).
  if (url.pathname.startsWith('/api/')) {
    const auth = await checkAuth(request, env);
    if (!auth.ok) return unauthorized(auth.locked);
  }

  if (request.method === 'POST' && url.pathname === '/api/chat') {
    return handleChat(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/api/transcribe') {
    return handleTranscribe(request, env);
  }

  // Fallback ke frontend statis (index.html, app.js, ...) di ./public
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    return withSecurityHeaders(await routeRequest(request, env));
  },
};

// Diekspor hanya untuk unit test (fail-fast konfigurasi auth, perbandingan
// token, dan helper timeout outbound Task #013).
export { authConfigError, tokensMatch, fetchWithTimeout, ProviderTimeoutError, envTimeoutMs };
