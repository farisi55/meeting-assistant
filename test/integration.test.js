// Integration end-to-end (Task #016): menggerakkan fetch handler yang
// diekspor worker.js (default export) melalui seluruh rantai request —
// fail-fast konfigurasi -> auth /api/* -> handleChat -> panggilan provider
// HTTP — bukan fungsi internal satu per satu. Hermetik: panggilan keluar
// provider di-intercept lewat pergantian globalThis.fetch (tak ada jaringan
// nyata; URL tak didefinisikan melempar, peran disableNetConnect), kredensial
// dummy, dan state KV lockout ditebas di afterEach — tak ada state yang
// tertinggal memengaruhi run berikutnya (isolasi @knowledge §4).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../worker.js';

const TOKEN = 'e2e-bearer-token-1234';
const IP = '198.51.100.7'; // IP tes khusus, beda dengan 203.0.113.9 di worker.test.js
const LOCK_KEY = `authfail:${IP}`;

// Env sintetis per test — AUTH_KV memakai binding KV asli dari runtime
// supaya mekanisme lockout diuji apa adanya; OPENROUTER_API_KEY diset supaya
// jalur chat hidup, mistral dilewati (key-nya tidak ada) seperti produksi.
const makeEnv = (overrides = {}) => ({
  AUTH_ENABLED: 'true',
  BASIC_AUTH_TOKEN: TOKEN,
  AUTH_KV: env.AUTH_KV,
  OPENROUTER_API_KEY: 'e2e-openrouter-key-not-a-secret',
  ASSETS: { fetch: async () => new Response('asset-ok') },
  ...overrides,
});

const chatRequest = (headers = {}) =>
  new Request('https://example.com/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'halo' }] }),
  });

const respond = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let originalFetch;
let outboundCalls; // { url, init } untuk tiap panggilan keluar
let routes;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  outboundCalls = [];
  routes = {};
  globalThis.fetch = async (url, init) => {
    outboundCalls.push({ url: String(url), init });
    const handler = routes[new URL(url).hostname];
    if (!handler) throw new Error(`panggilan keluar tak ter-intercept: ${url}`);
    return handler();
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (env.AUTH_KV) await env.AUTH_KV.delete(LOCK_KEY); // state test ini tidak boleh tertinggal
});

describe('end-to-end: auth -> /api/chat -> provider (Task #016)', () => {
  it('rejects an unauthenticated request before the provider is ever called', async () => {
    const res = await worker.fetch(chatRequest(), makeEnv()); // tanpa header Authorization

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    expect(outboundCalls).toEqual([]); // diblokir sebelum logika bisnis
    // Header hilang = "silakan login", bukan percobaan gagal → tak ada state lockout
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull();
  });

  it('rejects a wrong bearer token without touching the provider', async () => {
    const res = await worker.fetch(
      chatRequest({ Authorization: 'Bearer token-salah', 'CF-Connecting-IP': IP }),
      makeEnv(),
    );

    expect(res.status).toBe(401);
    expect(outboundCalls).toEqual([]);
    // Percobaan gagal tercatat di KV (mekanisme lockout hidup), lalu ditebas
    // afterEach — run berikutnya tidak mewarisi hitungan ini.
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBe('1');
  });

  it('returns the mocked provider response end-to-end with security headers', async () => {
    routes['openrouter.ai'] = () =>
      respond(200, { choices: [{ message: { content: 'Halo dari OpenRouter' } }] });

    const res = await worker.fetch(
      chatRequest({ Authorization: `Bearer ${TOKEN}`, 'CF-Connecting-IP': IP }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const data = await res.json();
    expect(data._provider).toBe('openrouter');
    expect(data.choices[0].message.content).toBe('Halo dari OpenRouter');

    // Tepat satu panggilan keluar: ke OpenRouter (provider pertama rantai),
    // dengan kredensial env yang benar, payload messages diteruskan apa adanya.
    expect(outboundCalls).toHaveLength(1);
    expect(outboundCalls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(outboundCalls[0].init.headers.Authorization).toBe(
      'Bearer e2e-openrouter-key-not-a-secret',
    );
    const sent = JSON.parse(outboundCalls[0].init.body);
    expect(sent.messages).toEqual([{ role: 'user', content: 'halo' }]);
    expect(sent.stream).toBe(false);

    // withSecurityHeaders membungkus respons sukses juga
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");

    // Login benar → counter lockout tidak tersisa (delete pada key yang tak pernah ada)
    expect(await env.AUTH_KV.get(LOCK_KEY)).toBeNull();
  });
});
