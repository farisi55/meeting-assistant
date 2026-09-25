// Tests for the "Steer AI" response-drafting mode (Task #010, knowledge §7) —
// system-prompt construction (no live network), draft wiring via mocked
// fetchFn, visible copy action, and error surfacing.
// Isolation: fresh root per test, clipboard stub restored in afterEach.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STEER_SYSTEM_PROMPT, draftSteer, initApp, mountSteerPanel } from '../../public/app.js';

const okReply = (text, provider = 'groq') => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: text } }], _provider: provider }),
  text: async () => '{}',
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

let root;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

const points = () => root.querySelector('[data-testid="steer-points"]');
const submit = () => root.querySelector('[data-testid="steer-submit"]');
const copyBtn = () => root.querySelector('[data-testid="steer-copy"]');
const output = () => root.querySelector('[data-testid="steer-output"]');
const error = () => root.querySelector('[data-testid="steer-error"]');
const status = () => root.querySelector('[data-testid="steer-status"]');

const waitFor = async (assertion) => {
  await vi.waitFor(assertion, { timeout: 1000 });
};

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete navigator.clipboard;
  root.remove();
});

describe('Steer AI response drafting (Task #010)', () => {
  it('STEER_SYSTEM_PROMPT explicitly forbids introducing new claims (knowledge §7)', () => {
    expect(STEER_SYSTEM_PROMPT).toMatch(/never introduce new claims/i);
    expect(STEER_SYSTEM_PROMPT).toMatch(/only the rough points/i);
    expect(STEER_SYSTEM_PROMPT).toMatch(/statistics/i);
    expect(STEER_SYSTEM_PROMPT).toMatch(/commitments/i);
  });

  it('draftSteer sends the system prompt + user points and resolves the draft — no live network', async () => {
    const fetchFn = makeFetch(async () => okReply('respons yang disusun'));

    const result = await draftSteer('  poin kasar saya  ', { fetchFn });

    expect(result).toMatchObject({ text: 'respons yang disusun', provider: 'groq' });
    const [url, init] = fetchFn.calls[0];
    expect(url).toBe('/api/chat');
    const body = JSON.parse(init.body);
    expect(body.messages[0]).toEqual({ role: 'system', content: STEER_SYSTEM_PROMPT });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'poin kasar saya' });
  });

  it('draftSteer rejects empty/whitespace points before any network call', async () => {
    const fetchFn = makeFetch(async () => okReply('x'));

    await expect(draftSteer('   ', { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(draftSteer(undefined, { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetchFn.calls).toHaveLength(0);
  });

  it('submitting rough points renders the fluent output and reveals a visible copy action', async () => {
    const fetchFn = makeFetch(async () => okReply('draft rapi', 'mistral'));
    mountSteerPanel(root, { fetchFn });

    expect(copyBtn().hidden).toBe(true); // belum ada hasil → belum ada aksi salin
    points().value = 'halo, terima kasih atas wawancara kemarin';
    submit().click();

    await waitFor(() => expect(output().textContent).toBe('draft rapi'));
    expect(copyBtn().hidden).toBe(false); // visible copy action
    expect(status().textContent).toContain('mistral');
    expect(submit().disabled).toBe(false); // tombol aktif kembali setelah selesai
    expect(error().hidden).toBe(true);
  });

  it('the copy action writes exactly the rendered output via the clipboard API', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fetchFn = makeFetch(async () => okReply('teks hasil draft'));
    mountSteerPanel(root, { fetchFn });

    points().value = 'poin';
    submit().click();
    await waitFor(() => expect(copyBtn().hidden).toBe(false));

    copyBtn().click();
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('teks hasil draft');
    expect(status().textContent).toBe('Tersalin');
  });

  it('a failed draft surfaces a visible error, keeps output/copy hidden, and re-enables submit', async () => {
    const fetchFn = makeFetch(async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error('bukan JSON');
      },
      text: async () => 'upstream error',
    }));
    mountSteerPanel(root, { fetchFn });

    points().value = 'poin yang gagal';
    submit().click();

    await waitFor(() => expect(error().hidden).toBe(false));
    expect(error().textContent).toContain('503');
    expect(output().textContent).toBe('');
    expect(copyBtn().hidden).toBe(true);
    expect(submit().disabled).toBe(false);
    expect(status().textContent).toBe('');
  });

  it('copy failure shows a catchable inline message instead of an unhandled rejection', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn(async () => {
          throw new Error('clipboard denied');
        }),
      },
      configurable: true,
    });
    const fetchFn = makeFetch(async () => okReply('isi hasil'));
    mountSteerPanel(root, { fetchFn });

    points().value = 'poin';
    submit().click();
    await waitFor(() => expect(copyBtn().hidden).toBe(false));

    copyBtn().click();
    await waitFor(() => expect(error().hidden).toBe(false));
    expect(error().textContent).toContain('Gagal menyalin');
  });

  it('initApp mounts both the context-upload and Steer AI panels', () => {
    const appRoot = document.createElement('div');
    appRoot.id = 'app';
    document.body.append(appRoot);

    const handle = initApp(appRoot, { storage: localStorage });

    expect(appRoot.querySelector('[data-testid="context-panel"]')).toBeTruthy(); // Task #008 tetap terpasang
    expect(appRoot.querySelector('[data-testid="steer-panel"]')).toBeTruthy();
    handle.destroy();
    expect(appRoot.querySelector('[data-testid="steer-panel"]')).toBeNull();
    appRoot.remove();
  });
});
