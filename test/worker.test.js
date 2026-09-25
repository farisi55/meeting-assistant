import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
