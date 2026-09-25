// Tests for public/providers.js (Task #009) — /api/chat + /api/transcribe
// client wrapper: success resolves with reply text + `_provider`, every
// failure state surfaces as a catchable ProvidersError (knowledge §5).
// Isolation: each test builds its own fetchFn closure; no shared or global state.
import { describe, expect, it } from 'vitest';
import { ProvidersError, chat, transcribe } from '../../public/providers.js';

const okJson = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const errResponse = (status, bodyText) => ({
  ok: false,
  status,
  json: async () => {
    throw new Error('bukan JSON');
  },
  text: async () => bodyText,
});

const makeFetch = (impl) => {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  return fn;
};

describe('providers client helper (Task #009)', () => {
  it('chat() resolves with the reply text and _provider from a successful /api/chat response', async () => {
    const fetchFn = makeFetch(async () =>
      okJson({ choices: [{ message: { content: 'halo dari groq' } }], _provider: 'groq', usage: {} }),
    );

    const result = await chat([{ role: 'user', content: 'tes' }], { fetchFn });

    expect(result).toMatchObject({ text: 'halo dari groq', provider: 'groq' });
    expect(result.raw).toHaveProperty('usage');
    const [url, init] = fetchFn.calls[0];
    expect(url).toBe('/api/chat');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: 'user', content: 'tes' }] });
  });

  it('chat() passes provider/model/temperature/maxTokens through to the request body', async () => {
    const fetchFn = makeFetch(async () => okJson({ choices: [{ message: { content: 'ok' } }], _provider: 'mistral' }));

    await chat([{ role: 'user', content: 'x' }], { fetchFn, provider: 'mistral', model: 'm1', temperature: 0.2, maxTokens: 250 });

    expect(JSON.parse(fetchFn.calls[0][1].body)).toEqual({
      messages: [{ role: 'user', content: 'x' }],
      provider: 'mistral',
      model: 'm1',
      temperature: 0.2,
      max_tokens: 250,
    });
  });

  it('chat() surfaces an all-providers-failed response (429) as a catchable ProvidersError', async () => {
    const fetchFn = makeFetch(async () => errResponse(429, '{"error":{"message":"rate limited"}}'));

    let caught = null;
    try {
      await chat([{ role: 'user', content: 'tes' }], { fetchFn });
    } catch (error) {
      caught = error; // ditangkap — bukan unhandled rejection
    }

    expect(caught).toBeInstanceOf(ProvidersError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('HTTP');
    expect(caught.status).toBe(429);
    expect(caught.body).toContain('rate limited');
    expect(caught.endpoint).toBe('/api/chat');
  });

  it('chat() surfaces a 500 no-keys plain-text response as a catchable ProvidersError', async () => {
    const fetchFn = makeFetch(async () => errResponse(500, 'Tidak ada provider dengan API key ter-set di environment'));

    await expect(chat([{ role: 'user', content: 'tes' }], { fetchFn })).rejects.toMatchObject({
      name: 'ProvidersError',
      status: 500,
      body: expect.stringContaining('Tidak ada provider'),
    });
  });

  it('chat() rejects with INVALID_RESPONSE on malformed success payloads instead of a TypeError', async () => {
    const noProvider = makeFetch(async () => okJson({ choices: [{ message: { content: 'x' } }] }));
    await expect(chat([{ role: 'user', content: 'x' }], { fetchFn: noProvider })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const noChoices = makeFetch(async () => okJson({ _provider: 'groq' }));
    await expect(chat([{ role: 'user', content: 'x' }], { fetchFn: noChoices })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const brokenJson = makeFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); }, text: async () => 'x' }));
    await expect(chat([{ role: 'user', content: 'x' }], { fetchFn: brokenJson })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('chat() validates messages before any network call', async () => {
    const fetchFn = makeFetch(async () => okJson({}));

    await expect(chat('bukan-array', { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(chat([], { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetchFn.calls).toHaveLength(0); // gagal sebelum fetch
  });

  it('transcribe() resolves with the Whisper text and posts multipart form-data', async () => {
    const fetchFn = makeFetch(async () => okJson({ text: 'hasil transkrip', task: 'transcribe' }));

    const result = await transcribe(new Blob(['audio']), { fetchFn, language: 'id' });

    expect(result).toMatchObject({ text: 'hasil transkrip' });
    const [url, init] = fetchFn.calls[0];
    expect(url).toBe('/api/transcribe');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('file')).toBeInstanceOf(Blob);
    expect(init.body.get('language')).toBe('id');
  });

  it('transcribe() surfaces upstream failures (400) as a catchable ProvidersError', async () => {
    const fetchFn = makeFetch(async () => errResponse(400, 'Field "file" wajib ada'));

    await expect(transcribe(new Blob(['audio']), { fetchFn })).rejects.toMatchObject({
      name: 'ProvidersError',
      code: 'HTTP',
      status: 400,
      body: 'Field "file" wajib ada',
    });
  });

  it('transcribe() validates the file argument before any network call', async () => {
    const fetchFn = makeFetch(async () => okJson({ text: 'x' }));

    await expect(transcribe('bukan-blob', { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetchFn.calls).toHaveLength(0);
  });

  it('passes an AbortSignal for the explicit timeout and maps aborts to a catchable ABORTED error', async () => {
    const withSignal = makeFetch(async () => okJson({ choices: [{ message: { content: 'ok' } }], _provider: 'groq' }));
    await chat([{ role: 'user', content: 'x' }], { fetchFn: withSignal, timeoutMs: 5000 });
    expect(withSignal.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    const aborted = makeFetch(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    await expect(chat([{ role: 'user', content: 'x' }], { fetchFn: aborted, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'ABORTED',
      endpoint: '/api/chat',
    });
  });

  it('maps network failures to a catchable NETWORK error', async () => {
    const fetchFn = makeFetch(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(chat([{ role: 'user', content: 'x' }], { fetchFn })).rejects.toMatchObject({
      name: 'ProvidersError',
      code: 'NETWORK',
    });
  });
});
