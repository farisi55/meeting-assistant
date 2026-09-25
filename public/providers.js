// public/providers.js — browser client helper for the Worker API (knowledge §5):
// wraps POST /api/chat and POST /api/transcribe, surfaces the `_provider`
// field on success and converts every failure into a catchable ProvidersError.

/** Catchable error for all API failure states; carries status/body/endpoint for UI handling. */
export class ProvidersError extends Error {
  /**
   * @param {string} message human-readable reason (never includes response PII)
   * @param {{code: string, status?: number, body?: string, endpoint?: string, cause?: unknown}} detail
   */
  constructor(message, { code, status, body, endpoint, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProvidersError';
    this.code = code;
    this.status = status ?? null;
    this.body = body ?? null;
    this.endpoint = endpoint ?? null;
  }
}

/** Build fetch init with an explicit abort signal: caller-supplied, else timeout. */
function buildSignal(timeoutMs, signal) {
  if (signal) return signal;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

/** Run fetch and convert network/abort failures into catchable ProvidersError. */
async function fetchOrThrow(fetchFn, url, init, endpoint) {
  try {
    return await fetchFn(url, init);
  } catch (cause) {
    const aborted = cause?.name === 'AbortError' || cause?.name === 'TimeoutError';
    throw new ProvidersError(aborted ? `${endpoint} gagal: timeout/abort` : `${endpoint} gagal di jaringan`, {
      code: aborted ? 'ABORTED' : 'NETWORK',
      endpoint,
      cause,
    });
  }
}

/** Read a failed response's body as text and throw it as a catchable ProvidersError. */
async function throwHttpError(res, endpoint) {
  let body = null;
  try {
    body = await res.text();
  } catch {
    body = null; // body unreadable → status alone still surfaces the failure
  }
  throw new ProvidersError(`${endpoint} merespons ${res.status}`, {
    code: 'HTTP',
    status: res.status,
    body,
    endpoint,
  });
}

/**
 * Call POST /api/chat (knowledge §5). Resolves with
 * { text, provider, raw } where `provider` is the response's `_provider`
 * field; rejects with ProvidersError on any failure state.
 */
export async function chat(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ProvidersError('messages harus berupa array yang tidak kosong', {
      code: 'VALIDATION',
      endpoint: '/api/chat',
    });
  }
  const { fetchFn = globalThis.fetch, timeoutMs = 60000, signal, provider, model, temperature, maxTokens } = options;
  const payload = { messages };
  if (provider !== undefined) payload.provider = provider;
  if (model !== undefined) payload.model = model;
  if (temperature !== undefined) payload.temperature = temperature;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;

  const res = await fetchOrThrow(
    fetchFn,
    '/api/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: buildSignal(timeoutMs, signal),
    },
    '/api/chat',
  );
  if (!res.ok) await throwHttpError(res, '/api/chat');

  let data;
  try {
    data = await res.json();
  } catch (cause) {
    throw new ProvidersError('Respons /api/chat bukan JSON yang valid', {
      code: 'INVALID_RESPONSE',
      endpoint: '/api/chat',
      cause,
    });
  }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || typeof data?._provider !== 'string' || data._provider === '') {
    throw new ProvidersError('Respons /api/chat tidak memuat choices[0].message.content + _provider', {
      code: 'INVALID_RESPONSE',
      endpoint: '/api/chat',
    });
  }
  return { text, provider: data._provider, raw: data };
}

/**
 * Call POST /api/transcribe (knowledge §5) with a multipart file.
 * Resolves with { text, raw } (Groq Whisper `response_format: json`);
 * rejects with ProvidersError on any failure state.
 */
export async function transcribe(file, options = {}) {
  if (!(file instanceof Blob)) {
    throw new ProvidersError('file harus berupa Blob/File audio', {
      code: 'VALIDATION',
      endpoint: '/api/transcribe',
    });
  }
  const { fetchFn = globalThis.fetch, timeoutMs = 120000, signal, model, language } = options;
  const form = new FormData();
  form.append('file', file, 'audio.webm');
  if (model !== undefined) form.append('model', model);
  if (language !== undefined) form.append('language', language);

  const res = await fetchOrThrow(
    fetchFn,
    '/api/transcribe',
    {
      method: 'POST',
      body: form,
      signal: buildSignal(timeoutMs, signal),
    },
    '/api/transcribe',
  );
  if (!res.ok) await throwHttpError(res, '/api/transcribe');

  let data;
  try {
    data = await res.json();
  } catch (cause) {
    throw new ProvidersError('Respons /api/transcribe bukan JSON yang valid', {
      code: 'INVALID_RESPONSE',
      endpoint: '/api/transcribe',
      cause,
    });
  }
  if (typeof data?.text !== 'string') {
    throw new ProvidersError('Respons /api/transcribe tidak memuat field text', {
      code: 'INVALID_RESPONSE',
      endpoint: '/api/transcribe',
    });
  }
  return { text: data.text, raw: data };
}
