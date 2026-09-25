import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { authConfigError } from '../worker.js';

describe('worker auth', () => {
  it('returns 401 when AUTH_ENABLED=true and no credentials are sent', async () => {
    const response = await SELF.fetch('https://example.com/api/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('does not count a missing Authorization header as a failed lockout attempt', async () => {
    // Dua request tanpa header Authorization sama sekali seharusnya tetap 401
    // biasa, bukan 429 — karena belum ada percobaan kredensial yang dihitung.
    await SELF.fetch('https://example.com/api/chat', { method: 'POST' });
    const second = await SELF.fetch('https://example.com/api/chat', { method: 'POST' });
    expect(second.status).toBe(401);
  });
});

describe('fail-fast konfigurasi auth (Task #003)', () => {
  const USER = 'test-user';
  const PASS = 's3cr3t-pass';

  // Env sintetis dibangun ulang di dalam tiap test — tidak ada state yang
  // dipakai bersama antar test, jadi test ini mandiri (isolated).
  const makeEnv = (overrides = {}) => ({
    AUTH_ENABLED: 'true',
    BASIC_AUTH_USER: USER,
    BASIC_AUTH_PASS: PASS,
    ASSETS: { fetch: async () => new Response('asset-ok') },
    ...overrides,
  });

  const chatRequest = () =>
    new Request('https://example.com/api/chat', { method: 'POST' });

  it('returns 500 naming only the var that is unset (BASIC_AUTH_USER)', async () => {
    const res = await worker.fetch(chatRequest(), makeEnv({ BASIC_AUTH_USER: undefined }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('BASIC_AUTH_USER');
    expect(text).not.toContain('BASIC_AUTH_PASS');
    expect(text).not.toContain(PASS); // nilai kredensial tidak pernah bocor
    expect(res.headers.get('WWW-Authenticate')).toBeNull(); // ini bukan challenge auth
  });

  it('returns 500 naming only the var that is unset (BASIC_AUTH_PASS)', async () => {
    const res = await worker.fetch(chatRequest(), makeEnv({ BASIC_AUTH_PASS: undefined }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('BASIC_AUTH_PASS');
    expect(text).not.toContain('BASIC_AUTH_USER');
    expect(text).not.toContain(PASS);
  });

  it('returns 500 naming both vars when both credentials are unset', async () => {
    const res = await worker.fetch(
      chatRequest(),
      makeEnv({ BASIC_AUTH_USER: undefined, BASIC_AUTH_PASS: undefined }),
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('BASIC_AUTH_USER');
    expect(text).toContain('BASIC_AUTH_PASS');
  });

  it('fails closed for static assets too when the auth config is broken', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/', { method: 'GET' }),
      makeEnv({ BASIC_AUTH_USER: undefined, BASIC_AUTH_PASS: undefined }),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toBe('asset-ok');
  });

  it('stays out of the way when AUTH_ENABLED is not "true"', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/', { method: 'GET' }),
      makeEnv({ AUTH_ENABLED: 'false', BASIC_AUTH_USER: undefined, BASIC_AUTH_PASS: undefined }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset-ok');
  });

  it('accepts correct credentials and rejects wrong ones when config is complete', async () => {
    const good = await worker.fetch(
      new Request('https://example.com/', {
        headers: { Authorization: `Basic ${btoa(`${USER}:${PASS}`)}` },
      }),
      makeEnv(),
    );
    expect(good.status).toBe(200);

    const bad = await worker.fetch(
      new Request('https://example.com/', {
        headers: { Authorization: `Basic ${btoa(`${USER}:salah`)}` },
      }),
      makeEnv(),
    );
    expect(bad.status).toBe(401);
  });

  it('authConfigError returns null unless AUTH_ENABLED is "true" with missing vars', () => {
    expect(authConfigError(makeEnv())).toBeNull();
    expect(authConfigError({ AUTH_ENABLED: 'false' })).toBeNull();
    expect(authConfigError({ AUTH_ENABLED: 'true' })).not.toBeNull();
    expect(authConfigError({})).toBeNull();
  });
});

describe('chat provider fallback chain (Task #005)', () => {
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
    expect(await res.text()).toContain('"marker":"sn"');
    expect(outboundCalls).toEqual([
      'openrouter.ai',
      'api.groq.com',
      'api.mistral.ai',
      'api.sambanova.ai',
    ]);
  });

  it('honours a forced provider and never touches the rest of the chain', async () => {
    routes['api.groq.com'] = () => respond(200, { choices: [] });

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
});

describe('transcribe proxy & auth lockout (Task #006)', () => {
  // Kedua test lockout sengaja memakai IP yang sama: test kedua memulai
  // dengan assert key KV sudah null — sekaligus membuktikan state test
  // sebelumnya benar-benar ditebas di afterEach (isolated, lihat kriteria).
  const IP = '203.0.113.9';
  const LOCK_KEY = `authfail:${IP}`;
  const USER = 'test-user';
  const PASS = 's3cr3t-pass';

  let originalFetch;
  let outboundCalls;

  const authHeaders = (pass, ip = IP) => ({
    'CF-Connecting-IP': ip,
    Authorization: `Basic ${btoa(`${USER}:${pass}`)}`,
  });

  const post = (path, headers) =>
    new Request(`https://example.com${path}`, { method: 'POST', headers });

  // Env sintetis per test; AUTH_KV memakai binding KV asli dari runtime
  // supaya mekanisme lockout diuji apa adanya, bukan terhadap tiruan.
  const makeEnv = (overrides = {}) => ({
    AUTH_ENABLED: 'true',
    BASIC_AUTH_USER: USER,
    BASIC_AUTH_PASS: PASS,
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

    const wrong = authHeaders('wrong-pass');
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(post('/api/chat', wrong), makeEnv());
      expect(res.status).toBe(401);
    }
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('3');

    const locked = await worker.fetch(post('/api/chat', authHeaders(PASS)), makeEnv());
    expect(locked.status).toBe(429);
    expect(locked.headers.get('Retry-After')).toBe('900');
    expect(await locked.text()).toContain('15 menit');
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('3'); // tetap terkunci
  });

  it('a successful login resets the failure counter', async () => {
    // IP yang sama dengan test lockout di atas — kalau afterEach tidak
    // me-tebas state, assert pertama ini gagal.
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull();

    const wrong = authHeaders('wrong-pass');
    expect((await worker.fetch(post('/api/chat', wrong), makeEnv())).status).toBe(401);
    expect((await worker.fetch(post('/api/chat', wrong), makeEnv())).status).toBe(401);
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('2');

    const success = await worker.fetch(
      new Request('https://example.com/', { method: 'GET', headers: authHeaders(PASS) }),
      makeEnv(),
    );
    expect(success.status).toBe(200);
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull(); // counter ter-reset

    expect((await worker.fetch(post('/api/chat', wrong), makeEnv())).status).toBe(401);
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('1'); // hitung ulang dari 1, bukan lanjut
  });
});
