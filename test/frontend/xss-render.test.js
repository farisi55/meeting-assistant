// Tests for XSS-safe rendering (Task #015, knowledge §6): untrusted text —
// meeting transcript, AI output, saved context — must land as literal DOM
// text via renderText/textContent, never parsed as markup. Includes a
// source-scan guardrail so a future HTML sink fails the suite, not review.
// Isolation: fresh root + localStorage per test; mediaDevices/MediaRecorder
// descriptors restored in afterEach (pattern from #007/#012).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderText, mountMeetingPanel, mountContextPanel, CONTEXT_STORAGE_KEY } from '../../public/app.js';

const EVIL = '<script>window.__xss=1</script><img src=x onerror="window.__xss=2"><b>tebal</b>&amp;';

describe('renderText helper (Task #015)', () => {
  it('renders a malicious-looking string as literal text with zero parsed markup', () => {
    const el = document.createElement('div');

    renderText(el, EVIL);

    expect(el.textContent).toBe(EVIL);
    expect(el.childElementCount).toBe(0);
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
  });

  it('renders null/undefined as empty text, matching the previous direct assignment', () => {
    const el = document.createElement('div');

    renderText(el, null);
    expect(el.textContent).toBe('');
    expect(el.childElementCount).toBe(0);

    renderText(el, undefined);
    expect(el.textContent).toBe('');
    renderText(el, 42);
    expect(el.textContent).toBe('42');
  });
});

describe('meeting transcript renders untrusted text literally (AC 1)', () => {
  class MockTrack extends EventTarget {
    constructor(kind = 'audio') {
      super();
      this.kind = kind;
      this.readyState = 'live';
      this.stop = vi.fn(() => {
        this.readyState = 'ended';
      });
    }
  }

  const makeStream = ({ audio = 1, video = 1 } = {}) => {
    const tracks = [
      ...Array.from({ length: audio }, () => new MockTrack('audio')),
      ...Array.from({ length: video }, () => new MockTrack('video')),
    ];
    return { getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio') };
  };

  class MockRecorder extends EventTarget {
    start() {}
    stop() {
      const event = new Event('dataavailable');
      Object.defineProperty(event, 'data', { value: new Blob(['final-chunk']) });
      this.dispatchEvent(event);
      this.dispatchEvent(new Event('stop'));
    }
  }

  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  let root;

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(globalThis, 'MediaRecorder', { value: MockRecorder, configurable: true, writable: true });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn(async () => makeStream()) },
      configurable: true,
      writable: true,
    });
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    localStorage.clear();
    if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    else delete navigator.mediaDevices;
    if (originalMediaRecorder) Object.defineProperty(globalThis, 'MediaRecorder', originalMediaRecorder);
    else delete globalThis.MediaRecorder;
    root.remove();
  });

  const byTestid = (id) => root.querySelector(`[data-testid="${id}"]`);

  it('a transcript chunk containing <script> and HTML-special chars shows as literal visible text', async () => {
    const fetchFn = vi.fn(async (url) =>
      url === '/api/transcribe'
        ? { ok: true, status: 200, json: async () => ({ text: EVIL }), text: async () => '{}' }
        : {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: EVIL } }], _provider: 'groq' }),
            text: async () => '{}',
          },
    );
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => makeStream());
    mountMeetingPanel(root, { fetchFn });

    byTestid('meeting-start').click();
    await vi.waitFor(() => expect(byTestid('meeting-status').textContent).toContain('Merekam'));
    byTestid('meeting-stop').click();
    await vi.waitFor(() => expect(byTestid('meeting-output').textContent).toBe(EVIL));

    const transcriptEl = byTestid('meeting-transcript');
    expect(transcriptEl.textContent).toBe(EVIL); // literal, bukan markup terparse
    expect(transcriptEl.childElementCount).toBe(0);
    expect(transcriptEl.querySelector('script')).toBeNull();

    const outputEl = byTestid('meeting-output');
    expect(outputEl.textContent).toBe(EVIL);
    expect(outputEl.childElementCount).toBe(0);

    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(window.__xss).toBeUndefined();
  });
});

describe('saved context restores into the textarea as literal text (AC 1)', () => {
  it('a context value containing markup lands in textarea.value, never parsed', () => {
    localStorage.setItem(
      CONTEXT_STORAGE_KEY,
      JSON.stringify({ cv: EVIL, jd: 'JD <i>italic</i>', productKnowledge: '' }),
    );
    const root = document.createElement('div');
    document.body.append(root);

    mountContextPanel(root);

    const [cvField] = root.querySelectorAll('textarea');
    expect(cvField.value).toBe(EVIL);
    expect(cvField.childElementCount).toBe(0); // value is text, not markup
    expect(root.querySelector('script')).toBeNull();
    root.remove();
    localStorage.clear();
  });
});

describe('no HTML sink anywhere in public/ sources (AC 2, grep-verifiable)', () => {
  // Guardrail source-scan seperti #004: aturan knowledge §6 dijadikan test.
  // Komentar dibuang dulu supaya dokumentasi yang MENYEBUT nama sink
  // (sebagai contoh yang dilarang) tidak ikut terdeteksi.
  const stripComments = (src) =>
    src
      .split('\n')
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
        return line.replace(/\/\/.*$/, '');
      })
      .join('\n');

  const SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write'];

  const publicSources = () => {
    const dir = resolve(process.cwd(), 'public');
    return readdirSync(dir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => ({ name, src: stripComments(readFileSync(join(dir, name), 'utf8')) }));
  };

  it('contains no HTML sink in any public/*.js module', () => {
    for (const { name, src } of publicSources()) {
      for (const sink of SINKS) {
        expect(src, `HTML sink ${sink} ditemukan di public/${name}`).not.toContain(sink);
      }
    }
  });

  it('routes the untrusted-content render sites through renderText', () => {
    const appSrc = readFileSync(resolve(process.cwd(), 'public', 'app.js'), 'utf8');
    for (const site of [
      'renderText(transcriptEl, transcriptText)',
      'renderText(outputEl, reply.text)',
      'renderText(output, result.text)',
      'renderText(question, session.question)',
      'renderText(feedback, session.feedback)',
    ]) {
      expect(appSrc, `situs render konten tidak lewat renderText: ${site}`).toContain(site);
    }
  });
});
