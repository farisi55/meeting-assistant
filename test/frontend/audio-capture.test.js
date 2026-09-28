// Tests for public/audio-capture.js — pure logic (track-presence, ended
// handling, chunk assembly) exercised with mocked MediaStream/MediaRecorder
// objects; no real capture devices required (knowledge §9 browser limits).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AudioCaptureError,
  assertHasAudioTrack,
  mixAudioStreams,
  startChunkedRecording,
  startDisplayCapture,
  startMicCapture,
  stopStream,
  watchTrackEnded,
} from '../../public/audio-capture.js';

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

const makeStream = ({ audio = 1, video = 0 } = {}) => {
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

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

const stubMediaDevices = (value) => {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true, writable: true });
};

describe('audio-capture module (Task #007)', () => {
  afterEach(() => {
    if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    else delete navigator.mediaDevices;
  });

  it('startMicCapture returns the live MediaStream from getUserMedia', async () => {
    const stream = makeStream();
    stubMediaDevices({ getUserMedia: vi.fn(async () => stream), getDisplayMedia: vi.fn() });

    const result = await startMicCapture();

    expect(result).toBe(stream);
    expect(result.getAudioTracks()).toHaveLength(1);
  });

  it('startDisplayCapture returns the live MediaStream from getDisplayMedia', async () => {
    const stream = makeStream({ audio: 1, video: 1 });
    stubMediaDevices({ getUserMedia: vi.fn(), getDisplayMedia: vi.fn(async () => stream) });

    const result = await startDisplayCapture();

    expect(result).toBe(stream);
    expect(result.getAudioTracks()).toHaveLength(1);
  });

  it('startDisplayCapture with zero audio tracks rejects with a distinct catchable AudioCaptureError and cleans up', async () => {
    const videoOnly = makeStream({ audio: 0, video: 1 });
    stubMediaDevices({ getUserMedia: vi.fn(), getDisplayMedia: vi.fn(async () => videoOnly) });

    await expect(startDisplayCapture()).rejects.toThrow(AudioCaptureError);
    await expect(startDisplayCapture()).rejects.toMatchObject({ code: 'NO_AUDIO_TRACK' });
    expect(videoOnly.getTracks()[0].stop).toHaveBeenCalled(); // tidak ada stream bocor
  });

  it('missing mediaDevices rejects with catchable MEDIA_UNAVAILABLE instead of a TypeError', async () => {
    stubMediaDevices(undefined);

    await expect(startMicCapture()).rejects.toMatchObject({
      name: 'AudioCaptureError',
      code: 'MEDIA_UNAVAILABLE',
    });
  });

  it('assertHasAudioTrack throws for a stream without audio tracks and passes otherwise', () => {
    expect(() => assertHasAudioTrack(makeStream({ audio: 0, video: 1 }))).toThrow(AudioCaptureError);
    expect(() => assertHasAudioTrack(makeStream({ audio: 1 }))).not.toThrow();
  });

  it('watchTrackEnded fires on a track ended event and stops after unsubscribe', () => {
    const stream = makeStream({ audio: 2 });
    const onEnded = vi.fn();
    const unsubscribe = watchTrackEnded(stream, onEnded);

    stream.getAudioTracks()[0].dispatchEvent(new Event('ended'));
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith(stream.getAudioTracks()[0]);

    unsubscribe();
    stream.getAudioTracks()[1].dispatchEvent(new Event('ended'));
    expect(onEnded).toHaveBeenCalledTimes(1); // listener sudah dilepas
  });

  it('startChunkedRecording collects non-empty chunks and resolves them on stop', async () => {
    let created;
    class CapturingRecorder extends MockRecorder {
      constructor(...args) {
        super(...args);
        created = this;
      }
    }
    const stream = makeStream();
    const { stop } = startChunkedRecording(stream, { timesliceMs: 2000, Recorder: CapturingRecorder });

    expect(created.startedWith).toBe(2000);
    const part1 = new Blob(['part-1']);
    created.emitChunk(part1);
    created.emitChunk(new Blob([])); // size 0 harus diabaikan

    const chunks = await stop();
    expect(chunks).toHaveLength(2); // part-1 + final-chunk dari stop()
    expect(chunks[0]).toBe(part1);
    expect(chunks[1].size).toBeGreaterThan(0);
  });

  it('startChunkedRecording records against the given stream', async () => {
    let created;
    class CapturingRecorder extends MockRecorder {
      constructor(...args) {
        super(...args);
        created = this;
      }
    }
    const stream = makeStream();
    startChunkedRecording(stream, { timesliceMs: 750, Recorder: CapturingRecorder });

    expect(created.stream).toBe(stream);
    created.stop();
  });

  it('stopStream stops every track on the stream', () => {
    const stream = makeStream({ audio: 1, video: 1 });

    stopStream(stream);

    for (const track of stream.getTracks()) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('exports AudioCaptureError with stable name and code', () => {
    const error = new AudioCaptureError('boom', 'SOME_CODE');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AudioCaptureError');
    expect(error.code).toBe('SOME_CODE');
    expect(error.message).toBe('boom');
  });
});

describe('mixAudioStreams (tab audio + mic)', () => {
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

  const inject = () => ({ AudioContext: FakeAudioContext, MediaStream: FakeMediaStream });

  it('connects both audio sources to one destination and returns a mixed stream with the display video', () => {
    const display = makeStream({ audio: 1, video: 1 });
    const mic = makeStream({ audio: 1, video: 0 });

    const { stream, close } = mixAudioStreams(display, mic, inject());

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.sources.map((source) => source.stream)).toEqual([display, mic]); // keduanya terhubung
    expect(ctx.sources).toHaveLength(2);
    for (const source of ctx.sources) expect(source.connect).toHaveBeenCalledTimes(1);
    expect(ctx.sources[0].connect.mock.calls[0][0]).toBe(ctx.destination);

    expect(stream).toBeInstanceOf(FakeMediaStream);
    expect(stream.getAudioTracks()).toEqual([ctx.destTrack]); // satu track audio campuran
    expect(stream.getVideoTracks()).toEqual(display.getVideoTracks()); // video display ikut

    close();
    for (const source of ctx.sources) expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toBe(true); // AudioContext dilepas
  });

  it('throws a catchable AUDIO_CONTEXT_UNAVAILABLE when Web Audio is unavailable (jsdom: no globals)', () => {
    let caught = null;
    try {
      mixAudioStreams(makeStream(), makeStream());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AudioCaptureError);
    expect(caught).toMatchObject({ code: 'AUDIO_CONTEXT_UNAVAILABLE' });
  });
});
