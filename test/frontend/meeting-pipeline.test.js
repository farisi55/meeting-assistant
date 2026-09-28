// Tests for the client-meeting pipeline (Task #012, knowledge §3 data flow):
// shared system-audio stream → chunked recording → POST /api/transcribe →
// transcript rendered → context-aware POST /api/chat → drafted response.
// Capture and network are both mocked (stubbed mediaDevices/MediaRecorder +
// injected fetchFn); no real devices and no live network.
// Isolation: fresh root per test, localStorage cleared in both hooks,
// navigator.mediaDevices and MediaRecorder descriptors restored in afterEach.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEETING_SYSTEM_PROMPT,
  CONTEXT_STORAGE_KEY,
  draftFromTranscript,
  buildTranscriptMessages,
  buildMeetingContext,
  initApp,
  mountMeetingPanel,
} from '../../public/app.js';
import { MAX_CONTEXT_CHARS } from '../../public/config.js';

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
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  };
};

/** Recorder that emits one final chunk on stop() (normal recording). */
class MockRecorder extends EventTarget {
  constructor(stream, options) {
    super();
    this.stream = stream;
    this.options = options;
    this.startedWith = null;
  }

  start(timeslice) {
    this.startedWith = timeslice;
  }

  stop() {
    this.emitChunk(new Blob(['final-chunk']));
    this.dispatchEvent(new Event('stop'));
  }

  emitChunk(data) {
    const event = new Event('dataavailable');
    Object.defineProperty(event, 'data', { value: data });
    this.dispatchEvent(event);
  }
}

/** Recorder that records nothing — stop() resolves with zero chunks. */
class SilentRecorder extends EventTarget {
  start() {}

  stop() {
    this.dispatchEvent(new Event('stop'));
  }
}

const transcribeReply = () => ({
  ok: true,
  status: 200,
  json: async () => ({ text: 'transkrip lawan bicara' }),
  text: async () => '{}',
});

const chatReply = (text = 'draft jawaban', provider = 'groq') => ({
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

const pipelineFetch = () =>
  makeFetch(async (url) => (url === '/api/transcribe' ? transcribeReply() : chatReply()));

const seedContext = (fields) => localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(fields));

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
const waitFor = async (assertion) => {
  await vi.waitFor(assertion, { timeout: 1000 });
};

describe('meeting pipeline message assembly (knowledge §3)', () => {
  it('buildTranscriptMessages carries the mode persona, clamped context, and the transcript as user message', () => {
    const context = {
      cv: 'CV Banu',
      jd: 'JD klien',
      productKnowledge: '☃'.repeat(MAX_CONTEXT_CHARS + 400), // over cap → wajib di-clamp
    };

    const messages = buildTranscriptMessages('Klien bertanya soal harga.', context);

    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain(MEETING_SYSTEM_PROMPT);
    expect(messages[0].content).toContain('CV Banu');
    expect(messages[0].content).toContain('JD klien');
    expect(messages[0].content.split('☃').length - 1).toBe(MAX_CONTEXT_CHARS); // hanya konten yang di-clamp
    expect(messages[1]).toEqual({ role: 'user', content: 'Klien bertanya soal harga.' });
  });

  it('buildMeetingContext tolerates missing and non-string values', () => {
    expect(buildMeetingContext(undefined)).toEqual({ cv: '', jd: '', productKnowledge: '' });
    expect(buildMeetingContext({ cv: 7, jd: null, productKnowledge: ['x'] })).toEqual({
      cv: '',
      jd: '',
      productKnowledge: '',
    });
  });

  it('draftFromTranscript rejects an empty transcript with VALIDATION before any network call', async () => {
    const fetchFn = makeFetch(async () => chatReply());

    await expect(draftFromTranscript('', { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(draftFromTranscript('   ', { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(draftFromTranscript(undefined, { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(fetchFn.calls).toHaveLength(0);
  });

  it('draftFromTranscript reflects the context saved at call time (currently active mode context)', async () => {
    const fetchFn = makeFetch(async () => chatReply());
    seedContext({ cv: 'CV lama', jd: 'JD lama', productKnowledge: 'Paket Pro Rp10' });

    await draftFromTranscript('transkrip pertama', { fetchFn });
    const firstSystem = JSON.parse(fetchFn.calls[0][1].body).messages[0].content;
    expect(firstSystem).toContain(MEETING_SYSTEM_PROMPT);
    expect(firstSystem).toContain('Paket Pro Rp10');

    seedContext({ cv: 'CV baru', jd: 'JD baru', productKnowledge: 'Paket Enterprise' }); // konteks diganti tanpa reload
    await draftFromTranscript('transkrip kedua', { fetchFn });
    const secondSystem = JSON.parse(fetchFn.calls[1][1].body).messages[0].content;
    expect(secondSystem).toContain('Paket Enterprise');
    expect(secondSystem).not.toContain('Paket Pro Rp10');
    expect(JSON.parse(fetchFn.calls[1][1].body).messages[1].content).toBe('transkrip kedua');
  });
});

describe('meeting pipeline panel wiring (capture + network mocked)', () => {
  it('shared system-audio stream → transcript rendered → context-aware draft, in that order', async () => {
    seedContext({ cv: 'CV Banu', jd: 'JD klien', productKnowledge: 'Harga paket Pro' });
    const fetchFn = pipelineFetch();
    const displayStream = makeStream({ audio: 1, video: 1 });
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => displayStream);
    mountMeetingPanel(root, { fetchFn });

    expect(byTestid('meeting-stop').disabled).toBe(true);
    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-status').textContent).toContain('Merekam'));
    expect(byTestid('meeting-start').disabled).toBe(true); // tidak bisa mulai dua kali
    expect(byTestid('meeting-stop').disabled).toBe(false);

    byTestid('meeting-stop').click();
    await waitFor(() => expect(byTestid('meeting-output').textContent).toBe('draft jawaban'));

    // urutan data flow §3: transkrip dulu, baru draft
    expect(fetchFn.calls.map(([url]) => url)).toEqual(['/api/transcribe', '/api/chat']);
    expect(byTestid('meeting-transcript').textContent).toBe('transkrip lawan bicara');
    expect(byTestid('meeting-status').textContent).toContain('groq');
    expect(byTestid('meeting-error').hidden).toBe(true);

    const body = JSON.parse(fetchFn.calls[1][1].body);
    expect(body.messages[0].content).toContain(MEETING_SYSTEM_PROMPT);
    expect(body.messages[0].content).toContain('Harga paket Pro');
    expect(body.messages[1].content).toBe('transkrip lawan bicara');

    expect(displayStream.getTracks()[0].stop).toHaveBeenCalled(); // stream dilepas setelah diproses
    expect(byTestid('meeting-start').disabled).toBe(false);
    expect(byTestid('meeting-stop').disabled).toBe(true);
  });

  it('a share without audio surfaces the NO_AUDIO_TRACK error and makes zero network calls', async () => {
    const fetchFn = pipelineFetch();
    const videoOnly = makeStream({ audio: 0, video: 1 });
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => videoOnly);
    mountMeetingPanel(root, { fetchFn });

    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-error').hidden).toBe(false));

    expect(byTestid('meeting-error').textContent).toMatch(/no audio track/i);
    expect(fetchFn.calls).toHaveLength(0);
    expect(byTestid('meeting-status').textContent).toBe('');
    expect(videoOnly.getTracks()[0].stop).toHaveBeenCalled(); // tidak ada stream bocor
    expect(byTestid('meeting-start').disabled).toBe(false); // bisa dicoba ulang
    expect(byTestid('meeting-stop').disabled).toBe(true);
  });

  it('stopping a recording that captured no audio errors visibly without any network call', async () => {
    Object.defineProperty(globalThis, 'MediaRecorder', { value: SilentRecorder, configurable: true, writable: true });
    const fetchFn = pipelineFetch();
    mountMeetingPanel(root, { fetchFn });

    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-status').textContent).toContain('Merekam'));
    byTestid('meeting-stop').click();

    await waitFor(() => expect(byTestid('meeting-error').hidden).toBe(false));
    expect(byTestid('meeting-error').textContent).toContain('Tidak ada audio');
    expect(fetchFn.calls).toHaveLength(0);
    expect(byTestid('meeting-transcript').textContent).toBe('');
    expect(byTestid('meeting-output').textContent).toBe('');
  });

  it('a failed draft keeps the rendered transcript and surfaces the error', async () => {
    const fetchFn = makeFetch(async (url) =>
      url === '/api/transcribe'
        ? transcribeReply()
        : { ok: false, status: 503, json: async () => ({}), text: async () => 'upstream down' },
    );
    mountMeetingPanel(root, { fetchFn });

    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-status').textContent).toContain('Merekam'));
    byTestid('meeting-stop').click();

    await waitFor(() => expect(byTestid('meeting-error').hidden).toBe(false));
    expect(byTestid('meeting-error').textContent).toContain('503');
    expect(byTestid('meeting-transcript').textContent).toBe('transkrip lawan bicara'); // transkrip tetap tampil
    expect(byTestid('meeting-output').textContent).toBe('');
    expect(fetchFn.calls).toHaveLength(2);
    expect(byTestid('meeting-start').disabled).toBe(false); // sesi bisa dimulai lagi
    expect(byTestid('meeting-stop').disabled).toBe(true);
  });

  it('a failed transcribe surfaces the error and never requests a draft', async () => {
    const fetchFn = makeFetch(async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'bad audio',
    }));
    mountMeetingPanel(root, { fetchFn });

    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-status').textContent).toContain('Merekam'));
    byTestid('meeting-stop').click();

    await waitFor(() => expect(byTestid('meeting-error').hidden).toBe(false));
    expect(byTestid('meeting-error').textContent).toContain('400');
    expect(fetchFn.calls).toHaveLength(1); // hanya /api/transcribe
    expect(fetchFn.calls[0][0]).toBe('/api/transcribe');
    expect(byTestid('meeting-output').textContent).toBe('');
  });

  it('the shared track ending auto-processes the recorded audio', async () => {
    const fetchFn = pipelineFetch();
    const displayStream = makeStream({ audio: 1, video: 1 });
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => displayStream);
    mountMeetingPanel(root, { fetchFn });

    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-status').textContent).toContain('Merekam'));

    displayStream.getAudioTracks()[0].dispatchEvent(new Event('ended')); // user stop-share via UI browser

    await waitFor(() => expect(byTestid('meeting-output').textContent).toBe('draft jawaban'));
    expect(byTestid('meeting-status').textContent).toContain('Sesi share berakhir');
    expect(fetchFn.calls.map(([url]) => url)).toEqual(['/api/transcribe', '/api/chat']);
    expect(byTestid('meeting-start').disabled).toBe(false);

    byTestid('meeting-stop').click(); // sudah diproses → klik stop kedua tidak menambah request
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchFn.calls).toHaveLength(2);
  });

  it('destroy() while recording releases the stream and clears the panel', async () => {
    const displayStream = makeStream({ audio: 1, video: 1 });
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => displayStream);
    const handle = mountMeetingPanel(root, { fetchFn: pipelineFetch() });

    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-status').textContent).toContain('Merekam'));

    handle.destroy();

    expect(displayStream.getTracks()[0].stop).toHaveBeenCalled();
    expect(root.children).toHaveLength(0);
  });

  it('initApp mounts the meeting panel alongside the other four panels and destroy releases everything', () => {
    const appRoot = document.createElement('div');
    appRoot.id = 'app';
    document.body.append(appRoot);

    const handle = initApp(appRoot, { storage: localStorage });

    expect(appRoot.querySelector('[data-testid="auth-panel"]')).toBeTruthy();
    expect(appRoot.querySelector('[data-testid="context-panel"]')).toBeTruthy();
    expect(appRoot.querySelector('[data-testid="steer-panel"]')).toBeTruthy();
    expect(appRoot.querySelector('[data-testid="practice-panel"]')).toBeTruthy();
    expect(appRoot.querySelector('[data-testid="meeting-panel"]')).toBeTruthy();

    handle.destroy();
    expect(appRoot.querySelector('[data-testid="meeting-panel"]')).toBeNull();
    expect(appRoot.children).toHaveLength(0);
    appRoot.remove();
  });
});

describe('meeting panel microphone mixing (tab audio + mic)', () => {
  // jsdom tidak punya Web Audio/MediaStream — dua global ini di-stub per test
  // dan dikembalikan di afterEach (isolasi @knowledge §4).
  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const originalMediaStream = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sources = [];
      this.closed = false;
      FakeAudioContext.instances.push(this);
    }

    createMediaStreamSource(stream) {
      const source = { stream, connect: vi.fn(), disconnect: vi.fn() };
      this.sources.push(source);
      return source;
    }

    createMediaStreamDestination() {
      this.destTrack = new MockTrack('audio');
      const destTrack = this.destTrack;
      this.destination = {
        stream: { getAudioTracks: () => [destTrack], getTracks: () => [destTrack] },
      };
      return this.destination;
    }

    resume() {
      this.state = 'running';
      return Promise.resolve();
    }

    close() {
      this.state = 'closed';
      this.closed = true;
      return Promise.resolve();
    }
  }
  FakeAudioContext.instances = [];

  class FakeMediaStream {
    constructor(tracks = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks.filter((track) => track.kind === 'audio');
    }
    getVideoTracks() {
      return this.tracks.filter((track) => track.kind === 'video');
    }
  }

  let lastRecorder;
  class InspectRecorder extends MockRecorder {
    constructor(...args) {
      super(...args);
      lastRecorder = this;
    }
  }

  beforeEach(() => {
    FakeAudioContext.instances = [];
    lastRecorder = null;
    Object.defineProperty(globalThis, 'AudioContext', { value: FakeAudioContext, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'MediaStream', { value: FakeMediaStream, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'MediaRecorder', { value: InspectRecorder, configurable: true, writable: true });
  });

  afterEach(() => {
    if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
    else delete globalThis.AudioContext;
    if (originalMediaStream) Object.defineProperty(globalThis, 'MediaStream', originalMediaStream);
    else delete globalThis.MediaStream;
    // MediaRecorder/globalThis dikembalikan oleh afterEach file-level
  });

  it('records a mixed stream carrying both display audio and the microphone, then releases everything', async () => {
    const displayStream = makeStream({ audio: 1, video: 1 });
    const micStream = makeStream({ audio: 1, video: 0 });
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => displayStream);
    navigator.mediaDevices.getUserMedia = vi.fn(async () => micStream);
    const fetchFn = pipelineFetch();
    mountMeetingPanel(root, { fetchFn });

    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-status').textContent).toContain('audio tab + mikrofon'));

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.sources.map((source) => source.stream)).toEqual([displayStream, micStream]); // tab + mic
    for (const source of ctx.sources) expect(source.connect).toHaveBeenCalledTimes(1);

    // Yang direkam adalah stream campuran, bukan display mentah
    expect(lastRecorder.stream).toBeInstanceOf(FakeMediaStream);
    expect(lastRecorder.stream.getAudioTracks()).toEqual([ctx.destTrack]);
    expect(lastRecorder.stream.getVideoTracks()).toEqual(displayStream.getVideoTracks());

    byTestid('meeting-stop').click();
    await waitFor(() => expect(byTestid('meeting-output').textContent).toBe('draft jawaban'));

    expect(displayStream.getTracks().every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(micStream.getTracks().every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(ctx.closed).toBe(true); // AudioContext dilepas setelah diproses
    expect(byTestid('meeting-transcript').textContent).toBe('transkrip lawan bicara');
    expect(byTestid('meeting-status').textContent).toContain('groq');
    expect(byTestid('meeting-error').hidden).toBe(true);
  });

  it('falls back to display-only capture when the microphone is denied', async () => {
    const displayStream = makeStream({ audio: 1, video: 1 });
    navigator.mediaDevices.getDisplayMedia = vi.fn(async () => displayStream);
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    const fetchFn = pipelineFetch();
    mountMeetingPanel(root, { fetchFn });

    byTestid('meeting-start').click();
    await waitFor(() => expect(byTestid('meeting-status').textContent).toContain('Merekam'));

    expect(byTestid('meeting-status').textContent).toContain('mikrofon tidak aktif');
    expect(FakeAudioContext.instances).toHaveLength(0); // mixing tidak pernah dicoba
    expect(lastRecorder.stream).toBe(displayStream); // merekam display apa adanya

    byTestid('meeting-stop').click();
    await waitFor(() => expect(byTestid('meeting-output').textContent).toBe('draft jawaban'));
    expect(displayStream.getTracks().every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(byTestid('meeting-error').hidden).toBe(true);
  });
});
