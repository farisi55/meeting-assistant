import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, {
  authConfigError,
  tokensMatch,
  fetchWithTimeout,
  ProviderTimeoutError,
  envTimeoutMs,
} from '../worker.js';

// Nilai dummy (bukan rahasia) yang HARUS cocok dengan binding
// BASIC_AUTH_TOKEN di vitest.worker.config.js — dipakai jalur lewat SELF.fetch.
const TOKEN = 'test-bearer-token-1234';

describe('worker auth (Task #010A)', () => {
  it('returns 401 when AUTH_ENABLED=true and no credentials are sent', async () => {
    const response = await SELF.fetch('https://example.com/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  it('does not count a missing Authorization header as a failed lockout attempt', async () => {
    // Dua request tanpa header Authorization sama sekali seharusnya tetap 401
    // biasa, bukan 429 — karena belum ada percobaan kredensial yang dihitung.
    await SELF.fetch('https://example.com/api/chat', { method: 'POST' });
    const second = await SELF.fetch('https://example.com/api/chat', { method: 'POST' });
    expect(second.status).toBe(401);
  });

  it('accepts the configured Bearer token and reaches the route handler', async () => {
    const response = await SELF.fetch('https://example.com/api/chat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    // Auth lolos (bukan 401) → handler chat jalan → tak ada API key di
    // binding test (string kosong) → 500 by design.
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Tidak ada provider');
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });
});

describe('fail-fast konfigurasi auth (Task #003, Task #010A)', () => {
  const TOKEN = 'token-lokal-sintetis';

  // Env sintetis dibangun ulang di dalam tiap test — tidak ada state yang
  // dipakai bersama antar test, jadi test ini mandiri (isolated).
  const makeEnv = (overrides = {}) => ({
    AUTH_ENABLED: 'true',
    BASIC_AUTH_TOKEN: TOKEN,
    ASSETS: { fetch: async () => new Response('asset-ok') },
    ...overrides,
  });

  const chatRequest = () =>
    new Request('https://example.com/api/chat', { method: 'POST' });

  it('returns 500 naming BASIC_AUTH_TOKEN when it is unset', async () => {
    const res = await worker.fetch(chatRequest(), makeEnv({ BASIC_AUTH_TOKEN: undefined }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('BASIC_AUTH_TOKEN');
    expect(text).not.toContain(TOKEN); // nilai token tidak pernah bocor
    expect(res.headers.get('WWW-Authenticate')).toBeNull(); // ini bukan challenge auth
  });

  it('fails closed for static assets too when the auth config is broken', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/', { method: 'GET' }),
      makeEnv({ BASIC_AUTH_TOKEN: undefined }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toBe('asset-ok');
  });

  it('stays out of the way when AUTH_ENABLED is not "true"', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/', { method: 'GET' }),
      makeEnv({ AUTH_ENABLED: 'false', BASIC_AUTH_TOKEN: undefined }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset-ok');
  });

  it('accepts a correct Bearer token and rejects a wrong one on /api/* when config is complete', async () => {
    // Path /api/* — sejak Task #010B auth hanya menjaga API; shell statis
    // dilayani tanpa auth (lihat describe 'auth scope').
    const good = await worker.fetch(
      new Request('https://example.com/api/ping', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      makeEnv(),
    );
    expect(good.status).toBe(200);

    const bad = await worker.fetch(
      new Request('https://example.com/api/ping', {
        headers: { Authorization: 'Bearer token-salah' },
      }),
      makeEnv(),
    );
    expect(bad.status).toBe(401);

    // Skema lama (Basic) tidak lagi diterima — auth hanya Bearer.
    const legacy = await worker.fetch(
      new Request('https://example.com/api/ping', {
        headers: { Authorization: `Basic ${btoa(`${TOKEN}:${TOKEN}`)}` },
      }),
      makeEnv(),
    );
    expect(legacy.status).toBe(401);
  });

  it('authConfigError returns null unless AUTH_ENABLED is "true" with missing vars', () => {
    expect(authConfigError(makeEnv())).toBeNull();
    expect(authConfigError({ AUTH_ENABLED: 'false' })).toBeNull();
    expect(authConfigError({ AUTH_ENABLED: 'true' })).not.toBeNull();
    expect(authConfigError({})).toBeNull();
  });
});

describe('token comparison (Task #010A)', () => {
  // Fungsi murni tanpa state — tiap kasus input sendiri (isolated by design).

  it('matches identical tokens (incl. non-ASCII) and rejects near-misses', () => {
    expect(tokensMatch('abc123', 'abc123')).toBe(true);
    expect(tokensMatch('kunci-rahasia', 'kunci-rahaslx')).toBe(false); // sama panjang
    expect(tokensMatch('kunci', 'kunci-panjang')).toBe(false); // beda panjang, tidak melempar
    expect(tokensMatch('', 'x')).toBe(false);
    expect(tokensMatch('token', '')).toBe(false); // expected kosong = gagal tertutup
    expect(tokensMatch('køij-token', 'køij-token')).toBe(true);
  });
});

describe('chat provider fallback chain (Task #005, #014)', () => {
  // cloudflare:test@0.22.0 tidak mengekspor fetchMock, jadi interceptor
  // outbound dipasang dengan mengganti globalThis.fetch per test dan
  // dikembalikan di afterEach — tiap test memasang & membersihkan mock-nya
  // sendiri (isolated), dan URL yang tak didefinisikan melempar error
  // (peran disableNetConnect: tidak ada panggilan jaringan nyata).
  let originalFetch;
  let outboundCalls;
  let routes;

  const respond = (status, payload) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const chatRequest = (payload = { messages: [{ role: 'user', content: 'halo' }] }) =>
    new Request('https://example.com/api/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

  // Auth dimatikan di test ini supaya fokus murni ke rantai fallback;
  // jalur auth sudah dicakup test 'worker auth' & 'fail-fast' di atas.
  const envWith = (keys) => ({ AUTH_ENABLED: 'false', ...keys });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    outboundCalls = [];
    routes = {};
    globalThis.fetch = async (url) => {
      const host = new URL(url).hostname;
      outboundCalls.push(host);
      const handler = routes[host];
      if (!handler) throw new Error(`panggilan keluar tak ter-intercept: ${url}`);
      return handler();
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('falls back to the next provider in FALLBACK_ORDER on a non-2xx response', async () => {
    routes['openrouter.ai'] = () => respond(500, { error: { message: 'or down' } });
    routes['api.groq.com'] = () =>
      respond(200, { choices: [{ message: { content: 'jawaban groq' } }] });

    const res = await worker.fetch(
      chatRequest(),
      envWith({ OPENROUTER_API_KEY: 'or-key', GROQ_API_KEY: 'gq-key' }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data._provider).toBe('groq');
    expect(data.choices[0].message.content).toBe('jawaban groq');
    expect(outboundCalls).toEqual(['openrouter.ai', 'api.groq.com']);
  });

  it('skips a provider with no API key without throwing and without calling it', async () => {
    // Hanya GROQ_API_KEY yang di-set: openrouter (urutan pertama) harus
    // dilewati diam-diam tanpa error dan tanpa panggilan keluar.
    routes['api.groq.com'] = () =>
      respond(200, { choices: [{ message: { content: 'ok' } }] });

    const res = await worker.fetch(chatRequest(), envWith({ GROQ_API_KEY: 'gq-key' }));

    expect(res.status).toBe(200);
    expect((await res.json())._provider).toBe('groq');
    expect(outboundCalls).toEqual(['api.groq.com']);
  });

  it('returns the last provider actual status and body when every provider fails', async () => {
    routes['openrouter.ai'] = () => respond(500, { marker: 'or' });
    routes['api.groq.com'] = () => respond(503, { marker: 'gq' });
    routes['api.mistral.ai'] = () => respond(500, { marker: 'mi' });
    // SambaNova ada di rantai DEFAULT-nya sudah dikeluarkan (butuh billing):
    // routenya sengaja disiapkan — kalau ikut terpanggil, test ini gagal.
    routes['api.sambanova.ai'] = () => respond(500, { marker: 'sn' });

    const res = await worker.fetch(
      chatRequest(),
      envWith({
        OPENROUTER_API_KEY: 'k1',
        GROQ_API_KEY: 'k2',
        MISTRAL_API_KEY: 'k3',
        SAMBANOVA_API_KEY: 'k4',
      }),
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('"marker":"mi"');
    expect(outboundCalls).toEqual(['openrouter.ai', 'api.groq.com', 'api.mistral.ai']);
  });

  it('honours a forced provider and never touches the rest of the chain', async () => {
    routes['api.groq.com'] = () =>
      respond(200, { choices: [{ message: { content: 'jawaban groq' } }] });

    const res = await worker.fetch(
      chatRequest({ messages: [], provider: 'groq' }),
      envWith({ OPENROUTER_API_KEY: 'k1', GROQ_API_KEY: 'k2' }),
    );

    expect(res.status).toBe(200);
    expect((await res.json())._provider).toBe('groq');
    expect(outboundCalls).toEqual(['api.groq.com']);
  });

  it('rejects an unknown forced provider with 500 and makes no outbound call', async () => {
    const res = await worker.fetch(
      chatRequest({ messages: [], provider: 'not-a-real-provider' }),
      envWith({ GROQ_API_KEY: 'k2' }),
    );

    expect(res.status).toBe(500);
    expect(outboundCalls).toEqual([]);
  });

  it('returns 500 without throwing when no provider has an API key set', async () => {
    const res = await worker.fetch(chatRequest(), envWith({}));

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Tidak ada provider');
    expect(outboundCalls).toEqual([]);
  });

  it('advances to the next provider on a 429 rate-limit response (not only generic 5xx)', async () => {
    // 429 = sinyal rate-limit per @knowledge §9 (mis. OpenRouter 20 req/min);
    // rantai harus memperlakukannya seperti gagal dan lanjut ke berikutnya.
    routes['openrouter.ai'] = () =>
      respond(429, { error: { message: 'Rate limit exceeded for model' } });
    routes['api.groq.com'] = () =>
      respond(200, { choices: [{ message: { content: 'jawaban groq' } }] });

    const res = await worker.fetch(
      chatRequest(),
      envWith({ OPENROUTER_API_KEY: 'or-key', GROQ_API_KEY: 'gq-key' }),
    );

    expect(res.status).toBe(200);
    expect((await res.json())._provider).toBe('groq');
    expect(outboundCalls).toEqual(['openrouter.ai', 'api.groq.com']);
  });

  it('returns the last provider actual 429 status and body when every provider rate-limits', async () => {
    // Tiga 429 berurutan: klien menerima 429 asli dari provider terakhir
    // di rantai (Mistral) — bukan 500 generik. Route SambaNova disiapkan
    // tanpa sengaja: kalau rantai masih memanggilnya, marker 'sn' muncul
    // dan outboundCalls melebihi tiga → test gagal.
    routes['openrouter.ai'] = () => respond(429, { marker: 'or' });
    routes['api.groq.com'] = () => respond(429, { marker: 'gq' });
    routes['api.mistral.ai'] = () => respond(429, { marker: 'mi' });
    routes['api.sambanova.ai'] = () => respond(429, { marker: 'sn' });

    const res = await worker.fetch(
      chatRequest(),
      envWith({
        OPENROUTER_API_KEY: 'k1',
        GROQ_API_KEY: 'k2',
        MISTRAL_API_KEY: 'k3',
        SAMBANOVA_API_KEY: 'k4',
      }),
    );

    expect(res.status).toBe(429);
    expect(await res.text()).toContain('"marker":"mi"');
    expect(outboundCalls).toEqual(['openrouter.ai', 'api.groq.com', 'api.mistral.ai']);
  });

  it('passes a 429 through unchanged when a forced provider rate-limits (chain skipped)', async () => {
    routes['api.groq.com'] = () => respond(429, { marker: 'forced-gq' });

    const res = await worker.fetch(
      chatRequest({ messages: [], provider: 'groq' }),
      envWith({ OPENROUTER_API_KEY: 'k1', GROQ_API_KEY: 'k2' }),
    );

    expect(res.status).toBe(429);
    expect(await res.text()).toContain('"marker":"forced-gq"');
    expect(outboundCalls).toEqual(['api.groq.com']);
  });

  it('advances to the next provider when a 200 response carries no usable content (hotfix)', async () => {
    // Kasus produksi: model reasoning mengembalikan200 dengan content null
    // (teksnya di field reasoning) — bukan sukses, harus lanjut rantai.
    routes['openrouter.ai'] = () =>
      respond(200, { choices: [{ message: { content: null, reasoning: 'berpikir dulu' } }] });
    routes['api.groq.com'] = () =>
      respond(200, { choices: [{ message: { content: 'jawaban groq' } }] });

    const res = await worker.fetch(
      chatRequest(),
      envWith({ OPENROUTER_API_KEY: 'k1', GROQ_API_KEY: 'k2' }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data._provider).toBe('groq');
    expect(data.choices[0].message.content).toBe('jawaban groq');
    expect(outboundCalls).toEqual(['openrouter.ai', 'api.groq.com']);
  });

  it('passes the last 200 body through unchanged when every answer is unusable (hotfix)', async () => {
    routes['openrouter.ai'] = () =>
      respond(200, { choices: [{ message: { content: null } }], marker: 'or' });
    routes['api.groq.com'] = () =>
      respond(200, { choices: [{ message: { content: null } }], marker: 'gq' });

    const res = await worker.fetch(
      chatRequest(),
      envWith({ OPENROUTER_API_KEY: 'k1', GROQ_API_KEY: 'k2' }),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"marker":"gq"'); // badan provider terakhir, utuh
    expect(text).not.toContain('"marker":"or"');
    expect(text).not.toContain('_provider'); // bukan respons sukses → tanpa pembungkus
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(outboundCalls).toEqual(['openrouter.ai', 'api.groq.com']);
  });

  it('passes a forced provider 200 body through unchanged when its content is unusable (hotfix)', async () => {
    routes['api.groq.com'] = () => respond(200, { choices: [{ message: { content: null } }] });

    const res = await worker.fetch(
      chatRequest({ messages: [], provider: 'groq' }),
      envWith({ OPENROUTER_API_KEY: 'k1', GROQ_API_KEY: 'k2' }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices[0].message.content).toBeNull();
    expect(data._provider).toBeUndefined(); // gagal → badan asli apa adanya
    expect(outboundCalls).toEqual(['api.groq.com']);
  });

  it('recovers from a retired Groq default model via GET /models (hotfix)', async () => {
    const calls = [];
    let chatSeq = 0;
    let retriedModel = null;
    globalThis.fetch = async (url, init) => {
      const u = new URL(url);
      calls.push(`${u.hostname}${u.pathname}`);
      if (u.pathname.endsWith('/models')) {
        return respond(200, {
          data: [
            { id: 'whisper-large-v3-turbo', active: true },
            { id: 'openai/gpt-oss-20b', active: true },
          ],
        });
      }
      chatSeq += 1;
      if (chatSeq === 1) {
        return respond(404, {
          error: {
            message: 'The model does not exist or you do not have access to it.',
            code: 'model_not_found',
          },
        });
      }
      retriedModel = JSON.parse(init.body).model;
      return respond(200, { choices: [{ message: { content: 'dari model pengganti' } }] });
    };

    const res = await worker.fetch(chatRequest(), envWith({ GROQ_API_KEY: 'gq-key' }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data._provider).toBe('groq');
    expect(data.choices[0].message.content).toBe('dari model pengganti');
    expect(retriedModel).toBe('openai/gpt-oss-20b'); // whisper dibuang, production dipilih
    expect(calls).toEqual([
      'api.groq.com/openai/v1/chat/completions',
      'api.groq.com/openai/v1/models',
      'api.groq.com/openai/v1/chat/completions',
    ]);
  });

  it('advances to the next provider when GET /models also fails (no silent loop)', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      calls.push(`${u.hostname}${u.pathname}`);
      if (u.hostname === 'api.groq.com') {
        if (u.pathname.endsWith('/models')) return respond(500, { marker: 'models-down' });
        return respond(404, { error: { code: 'model_not_found' } });
      }
      return respond(200, { choices: [{ message: { content: 'jawaban mistral' } }] });
    };

    const res = await worker.fetch(
      chatRequest(),
      envWith({ GROQ_API_KEY: 'gq-key', MISTRAL_API_KEY: 'm-key' }),
    );

    expect(res.status).toBe(200);
    expect((await res.json())._provider).toBe('mistral');
    expect(calls).toEqual([
      'api.groq.com/openai/v1/chat/completions',
      'api.groq.com/openai/v1/models',
      'api.mistral.ai/v1/chat/completions',
    ]);
  });

  it('treats a /models list with no usable chat model as no recovery', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      calls.push(`${u.hostname}${u.pathname}`);
      if (u.hostname === 'api.groq.com') {
        if (u.pathname.endsWith('/models')) {
          return respond(200, { data: [{ id: 'whisper-large-v3-turbo', active: true }] });
        }
        return respond(404, { error: { code: 'model_not_found' } });
      }
      return respond(200, { choices: [{ message: { content: 'jawaban mistral' } }] });
    };

    const res = await worker.fetch(
      chatRequest(),
      envWith({ GROQ_API_KEY: 'gq-key', MISTRAL_API_KEY: 'm-key' }),
    );

    expect(res.status).toBe(200);
    expect((await res.json())._provider).toBe('mistral');
    expect(calls).toEqual([
      'api.groq.com/openai/v1/chat/completions',
      'api.groq.com/openai/v1/models',
      'api.mistral.ai/v1/chat/completions',
    ]);
  });

  it('skips model recovery when the client forces a model', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      calls.push(`${u.hostname}${u.pathname}`);
      return respond(404, { error: { code: 'model_not_found', marker: 'forced-404' } });
    };

    const res = await worker.fetch(
      chatRequest({ messages: [{ role: 'user', content: 'halo' }], model: 'model-pensiun' }),
      envWith({ GROQ_API_KEY: 'gq-key' }),
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toContain('"marker":"forced-404"');
    expect(calls).toEqual(['api.groq.com/openai/v1/chat/completions']); // tanpa /models
  });
});

describe('transcribe proxy & auth lockout (Task #006, #010A)', () => {
  // Kedua test lockout sengaja memakai IP yang sama: test kedua memulai
  // dengan assert key KV sudah null — sekaligus membuktikan state test
  // sebelumnya benar-benar ditebas di afterEach (isolated, lihat kriteria).
  const IP = '203.0.113.9';
  const LOCK_KEY = `authfail:${IP}`;
  const TOKEN = 'token-lokal-sintetis';

  let originalFetch;
  let outboundCalls;

  const authHeaders = (token, ip = IP) => ({
    'CF-Connecting-IP': ip,
    Authorization: `Bearer ${token}`,
  });

  const post = (path, headers) =>
    new Request(`https://example.com${path}`, { method: 'POST', headers });

  // Env sintetis per test; AUTH_KV memakai binding KV asli dari runtime
  // supaya mekanisme lockout diuji apa adanya, bukan terhadap tiruan.
  const makeEnv = (overrides = {}) => ({
    AUTH_ENABLED: 'true',
    BASIC_AUTH_TOKEN: TOKEN,
    AUTH_KV: env.AUTH_KV,
    ASSETS: { fetch: async () => new Response('asset-ok') },
    ...overrides,
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    outboundCalls = [];
    globalThis.fetch = async (url) => {
      outboundCalls.push(String(url));
      throw new Error(`panggilan keluar tak ter-intercept: ${url}`);
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (env.AUTH_KV) await env.AUTH_KV.delete(LOCK_KEY); // teardown state test ini
  });

  it('returns a clear 500 naming GROQ_API_KEY when it is unset, without calling upstream', async () => {
    const res = await worker.fetch(post('/api/transcribe'), makeEnv({ AUTH_ENABLED: 'false' }));

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('GROQ_API_KEY');
    expect(outboundCalls).toEqual([]); // tidak ada panggilan Groq yang nyangkut
  });

  it('locks the IP after 3 failed attempts: the 4th request gets 429 even with correct credentials', async () => {
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull(); // mulai dari bersih

    const wrong = authHeaders('token-salah');
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(post('/api/chat', wrong), makeEnv());
      expect(res.status).toBe(401);
    }
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('3');

    const locked = await worker.fetch(post('/api/chat', authHeaders(TOKEN)), makeEnv());
    expect(locked.status).toBe(429);
    expect(locked.headers.get('Retry-After')).toBe('900');
    expect(await locked.text()).toContain('15 menit');
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('3'); // tetap terkunci
  });

  it('a successful login resets the failure counter', async () => {
    // IP yang sama dengan test lockout di atas — kalau afterEach tidak
    // me-tebas state, assert pertama ini gagal.
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull();

    const wrong = authHeaders('token-salah');
    expect((await worker.fetch(post('/api/chat', wrong), makeEnv())).status).toBe(401);
    expect((await worker.fetch(post('/api/chat', wrong), makeEnv())).status).toBe(401);
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('2');

    // Path /api/* — auth (dan reset counter) hanya berlaku di API sejak #010B.
    const success = await worker.fetch(
      new Request('https://example.com/api/ping', { method: 'GET', headers: authHeaders(TOKEN) }),
      makeEnv(),
    );
    expect(success.status).toBe(200);
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull(); // counter ter-reset

    expect((await worker.fetch(post('/api/chat', wrong), makeEnv())).status).toBe(401);
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('1'); // hitung ulang dari 1, bukan lanjut
  });
});

describe('auth scope: API only (Task #010B)', () => {
  // Shell statis harus tetap termuat tanpa token saat AUTH_ENABLED=true —
  // browser tidak pernah menempelkan header Authorization ke document
  // request, jadi menjaga frontend di sini hanya membuat halaman 401.
  const TOKEN = 'token-lokal-sintetis';
  const IP = '203.0.113.10';
  const LOCK_KEY = `authfail:${IP}`;

  const makeEnv = (overrides = {}) => ({
    AUTH_ENABLED: 'true',
    BASIC_AUTH_TOKEN: TOKEN,
    AUTH_KV: env.AUTH_KV,
    ASSETS: { fetch: async () => new Response('asset-ok') },
    ...overrides,
  });

  afterEach(async () => {
    if (env.AUTH_KV) await env.AUTH_KV.delete(LOCK_KEY); // teardown state test ini
  });

  it('serves the static shell without any Authorization header while auth is enabled', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/', { method: 'GET' }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset-ok');
  });

  it('still requires the token on /api/*', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/api/chat', { method: 'POST' }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('ignores even a wrong token on a non-API path — lockout only counts /api/*', async () => {
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull(); // mulai dari bersih

    // Token SALAH sengaja dikirim ke path non-API: kalau auth masih global,
    // counter akan jadi '2' — dengan cakupan /api/* ia harus tetap null.
    const headers = { 'CF-Connecting-IP': IP, Authorization: 'Bearer token-salah' };
    await worker.fetch(new Request('https://example.com/', { method: 'GET', headers }), makeEnv());
    await worker.fetch(new Request('https://example.com/', { method: 'GET', headers }), makeEnv());

    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull(); // tidak ada hitungan auth di luar /api
  });
});

describe('outbound timeout & security headers (Task #013)', () => {
  // Tiap panggilan upstream dibatasi fetchWithTimeout (CHAT_TIMEOUT_MS /
  // TRANSCRIBE_TIMEOUT_MS). Provider hang harus di-abort, dihitung gagal,
  // dan rantai fallback lanjut — bukan menggantung. Semua respons juga
  // wajib membawa header keamanan (HSTS/XFO/XCTO/CSP tanpa unsafe-*).
  const envWith = (keys) => ({ AUTH_ENABLED: 'false', ...keys });

  let originalFetch;
  let outboundCalls;
  let routes;

  // Mock yang menggantung sampai AbortSignal meledak — kalau fetchWithTimeout
  // tidak mengirim signal, test ini gagal langsung (bukan hang tanpa batas).
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (!signal) {
        reject(new Error('hang tanpa signal — fetchWithTimeout wajib kirim AbortSignal'));
        return;
      }
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort);
    });

  const respond = (status, payload) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const chatRequest = (payload = { messages: [{ role: 'user', content: 'halo' }] }) =>
    new Request('https://example.com/api/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

  const transcribeRequest = () => {
    const form = new FormData();
    form.append('file', new Blob(['dummy-audio'], { type: 'audio/webm' }), 'chunk.webm');
    return new Request('https://example.com/api/transcribe', { method: 'POST', body: form });
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    outboundCalls = [];
    routes = {};
    globalThis.fetch = async (url, init) => {
      const u = new URL(url);
      outboundCalls.push(u.hostname + u.pathname);
      const handler = routes[u.hostname];
      if (!handler) throw new Error(`panggilan keluar tak ter-intercept: ${url}`);
      return handler(url, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('treats a hung provider as failed and falls back to the next one', async () => {
    routes['openrouter.ai'] = (_url, init) => hang(_url, init);
    routes['api.groq.com'] = () =>
      respond(200, { choices: [{ message: { content: 'jawaban groq' } }] });

    const started = Date.now();
    const res = await worker.fetch(
      chatRequest(),
      envWith({ OPENROUTER_API_KEY: 'or-key', GROQ_API_KEY: 'gq-key', CHAT_TIMEOUT_MS: '30' }),
    );

    expect(res.status).toBe(200);
    expect((await res.json())._provider).toBe('groq');
    expect(outboundCalls).toEqual([
      'openrouter.ai/api/v1/chat/completions',
      'api.groq.com/openai/v1/chat/completions',
    ]);
    // Bukti tidak menggantung sampai default 15 dtk.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('counts a body that never finishes as a timeout (header saja tidak cukup)', async () => {
    // Header 200 sampai seketika tapi isi tak pernah selesai — sebelumnya
    // timer dihapus saat header diterima sehingga baca body menggantung
    // tanpa batas. Sekarang harus ikut dihitung timeout dan rantai lanjut.
    // Mock meniru fetch sesungguhnya: abort meledakkan body stream (kalau
    // signal tidak dikirim, listener gagal → test gagal juga).
    routes['openrouter.ai'] = (_url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          init.signal.addEventListener('abort', () => controller.error(new Error('body di-abort')));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    routes['api.groq.com'] = () =>
      respond(200, { choices: [{ message: { content: 'jawaban groq' } }] });

    const started = Date.now();
    const res = await worker.fetch(
      chatRequest(),
      envWith({ OPENROUTER_API_KEY: 'or-key', GROQ_API_KEY: 'gq-key', CHAT_TIMEOUT_MS: '30' }),
    );

    expect(res.status).toBe(200);
    expect((await res.json())._provider).toBe('groq');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('returns 504 when every keyed provider hangs without ever responding', async () => {
    routes['api.groq.com'] = (_url, init) => hang(_url, init);

    const res = await worker.fetch(
      chatRequest(),
      envWith({ GROQ_API_KEY: 'gq-key', CHAT_TIMEOUT_MS: '30' }),
    );

    expect(res.status).toBe(504);
    expect(await res.text()).toContain('timeout');
    expect(outboundCalls).toEqual(['api.groq.com/openai/v1/chat/completions']);
  });

  it('keeps the last real provider error instead of masking it with 504', async () => {
    // OpenRouter memberi error nyata (500) sebelum Groq hang: respons
    // asli yang valid harus tetap diteruskan apa adanya.
    routes['openrouter.ai'] = () => respond(500, { marker: 'or' });
    routes['api.groq.com'] = (_url, init) => hang(_url, init);

    const res = await worker.fetch(
      chatRequest(),
      envWith({ OPENROUTER_API_KEY: 'k1', GROQ_API_KEY: 'k2', CHAT_TIMEOUT_MS: '30' }),
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('"marker":"or"');
  });

  it('returns 504 on a hung transcription upstream without hanging the request', async () => {
    routes['api.groq.com'] = (_url, init) => hang(_url, init);

    const started = Date.now();
    const res = await worker.fetch(
      transcribeRequest(),
      envWith({ GROQ_API_KEY: 'gq-key', TRANSCRIBE_TIMEOUT_MS: '30' }),
    );

    expect(res.status).toBe(504);
    expect(await res.text()).toContain('melebihi timeout');
    expect(outboundCalls).toEqual(['api.groq.com/openai/v1/audio/transcriptions']);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('fetchWithTimeout resolves a fast upstream and signals the request', async () => {
    let sawSignal = false;
    globalThis.fetch = async (_url, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return respond(200, { ok: true });
    };

    const res = await fetchWithTimeout('https://fast.example/x', {}, 500);

    expect(res.status).toBe(200);
    expect(sawSignal).toBe(true);
  });

  it('fetchWithTimeout aborts a hung upstream and throws ProviderTimeoutError', async () => {
    globalThis.fetch = (_url, init) => hang(_url, init);

    const err = await fetchWithTimeout('https://hang.example/x', {}, 20).catch((e) => e);

    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect(err.code).toBe('PROVIDER_TIMEOUT');
    expect(err.name).toBe('ProviderTimeoutError');
  });

  it('envTimeoutMs honours valid overrides and falls back on junk values', async () => {
    expect(envTimeoutMs({}, 'CHAT_TIMEOUT_MS', 999)).toBe(999);
    expect(envTimeoutMs({ CHAT_TIMEOUT_MS: '250' }, 'CHAT_TIMEOUT_MS', 999)).toBe(250);
    expect(envTimeoutMs({ CHAT_TIMEOUT_MS: 'abc' }, 'CHAT_TIMEOUT_MS', 999)).toBe(999);
    expect(envTimeoutMs({ CHAT_TIMEOUT_MS: '0' }, 'CHAT_TIMEOUT_MS', 999)).toBe(999);
    expect(envTimeoutMs({ CHAT_TIMEOUT_MS: '-5' }, 'CHAT_TIMEOUT_MS', 999)).toBe(999);
    expect(envTimeoutMs(undefined, 'CHAT_TIMEOUT_MS', 999)).toBe(999);
  });

  it('attaches HSTS, X-Frame-Options, X-Content-Type-Options and a strict CSP to static responses', async () => {
    const assetEnv = {
      AUTH_ENABLED: 'false',
      ASSETS: { fetch: async () => new Response('asset-ok') },
    };

    const res = await worker.fetch(new Request('https://example.com/', { method: 'GET' }), assetEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('attaches the same security headers to API error responses without dropping auth headers', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/api/chat', { method: 'POST' }),
      { AUTH_ENABLED: 'true', BASIC_AUTH_TOKEN: 'token-lokal-sintetis' },
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer'); // header asli tetap ada
  });
});
