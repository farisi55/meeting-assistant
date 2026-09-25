// public/audio-capture.js — mic/system-audio capture + chunked recording for
// the transcription pipeline (knowledge §3 data flow: capture → chunk →
// POST /api/transcribe). Browser limitations per knowledge §9: getDisplayMedia
// system audio is Chromium-only and may yield zero audio tracks.

/** Distinct, catchable error for every audio-capture failure mode (no silent failure). */
export class AudioCaptureError extends Error {
  /**
   * @param {string} message human-readable reason
   * @param {string} code stable machine-readable code (e.g. NO_AUDIO_TRACK)
   */
  constructor(message, code) {
    super(message);
    this.name = 'AudioCaptureError';
    this.code = code;
  }
}

/** Assert a capture stream carries at least one live audio track, else throw AudioCaptureError. */
export function assertHasAudioTrack(stream) {
  const audioTracks = stream?.getAudioTracks?.() ?? [];
  if (audioTracks.length === 0) {
    throw new AudioCaptureError(
      'Capture stream has no audio track — system-audio sharing is unsupported or audio was not included in the share (knowledge §9)',
      'NO_AUDIO_TRACK',
    );
  }
  return stream;
}

/** Return the browser's mediaDevices entry, or throw a catchable AudioCaptureError if unavailable. */
function getMediaDevices() {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) {
    throw new AudioCaptureError(
      'navigator.mediaDevices is unavailable — microphone access requires a secure context (HTTPS or localhost)',
      'MEDIA_UNAVAILABLE',
    );
  }
  return devices;
}

/** Capture the microphone as a live MediaStream (rejects with AudioCaptureError on failure). */
export async function startMicCapture(options = {}) {
  const stream = await getMediaDevices().getUserMedia({ audio: options.audio ?? true, video: false });
  try {
    return assertHasAudioTrack(stream);
  } catch (error) {
    stopStream(stream);
    throw error;
  }
}

/** Share a display/tab and return its MediaStream; throws if the share includes no audio track. */
export async function startDisplayCapture(options = {}) {
  const stream = await getMediaDevices().getDisplayMedia({ video: true, audio: options.audio ?? true });
  try {
    return assertHasAudioTrack(stream);
  } catch (error) {
    stopStream(stream);
    throw error;
  }
}

/** Stop every track on a stream (teardown on error paths and when the user stops capturing). */
export function stopStream(stream) {
  for (const track of stream?.getTracks?.() ?? []) {
    track.stop?.();
  }
}

/**
 * Invoke onEnded whenever any audio track of the stream fires its `ended`
 * event (e.g. the user clicks "Stop sharing" in the browser UI). Returns an
 * unsubscribe function; call it to release the listeners.
 */
export function watchTrackEnded(stream, onEnded) {
  const listeners = [];
  for (const track of stream?.getAudioTracks?.() ?? []) {
    const handler = () => onEnded(track);
    track.addEventListener?.('ended', handler);
    listeners.push([track, handler]);
  }
  return () => {
    for (const [track, handler] of listeners) {
      track.removeEventListener?.('ended', handler);
    }
  };
}

/**
 * Record a capture stream into time-sliced chunks via MediaRecorder.
 * Returns { stop() } which resolves with every non-empty chunk once
 * recording has ended — the caller concatenates/uploads them for
 * POST /api/transcribe.
 */
export function startChunkedRecording(stream, { timesliceMs = 5000, Recorder, mimeType } = {}) {
  const RecorderCtor = Recorder ?? globalThis.MediaRecorder;
  if (typeof RecorderCtor !== 'function') {
    throw new AudioCaptureError('MediaRecorder is unavailable in this browser', 'RECORDER_UNAVAILABLE');
  }
  const recorder = new RecorderCtor(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.addEventListener?.('dataavailable', (event) => {
    if (event?.data && event.data.size > 0) chunks.push(event.data);
  });
  recorder.start?.(timesliceMs);
  const stop = () =>
    new Promise((resolve) => {
      recorder.addEventListener?.('stop', () => resolve(chunks), { once: true });
      recorder.stop?.();
    });
  return { stop };
}
