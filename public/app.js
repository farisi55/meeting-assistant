// public/app.js — UI entry point: token-access panel (bearer token for the
// /api/* routes, knowledge §5), context-upload panel (CV / job description /
// product knowledge) with client-side 5,000-char cap enforcement and
// localStorage persistence (knowledge §7), the "Steer AI" response drafting
// panel (knowledge §7), and the interview-practice panel whose state machine
// gates feedback behind an explicit mark-complete (knowledge §7). Side-effect
// free: the browser bootstraps via initApp(); tests mount panels directly.

import { MAX_CONTEXT_CHARS } from './config.js';
import { ProvidersError, chat, getStoredAuthToken, setStoredAuthToken } from './providers.js';

/** The three context fields accepted by the app, in display order (knowledge §7). */
export const CONTEXT_FIELDS = [
  { key: 'cv', label: 'CV' },
  { key: 'jd', label: 'Deskripsi Pekerjaan' },
  { key: 'productKnowledge', label: 'Pengetahuan Produk' },
];

/** localStorage key under which the context object is persisted. */
export const CONTEXT_STORAGE_KEY = 'meeting-assistant.context';

/**
 * Validate one context field against the knowledge §7 cap.
 * Returns { ok, length, error } — error is a human-readable message when over cap.
 */
export function validateContextField(text) {
  const value = text ?? '';
  if (value.length > MAX_CONTEXT_CHARS) {
    return {
      ok: false,
      length: value.length,
      error: `Melebihi batas ${MAX_CONTEXT_CHARS} karakter (terisi ${value.length})`,
    };
  }
  return { ok: true, length: value.length, error: null };
}

/**
 * Load persisted context from storage; every known field defaults to '' so
 * callers never see undefined (storage may be empty or missing keys).
 */
export function loadContext(storage) {
  let raw = null;
  try {
    raw = storage.getItem(CONTEXT_STORAGE_KEY);
  } catch {
    raw = null; // storage unavailable/blocked → treat as empty
  }
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {}; // corrupted payload → start empty rather than crash the UI
  }
  const context = {};
  for (const { key } of CONTEXT_FIELDS) {
    context[key] = typeof parsed[key] === 'string' ? parsed[key] : '';
  }
  return context;
}

/**
 * Persist context fields after validating every one against the cap.
 * All-or-nothing: if any field is over cap, nothing is written and the
 * offending fields are returned in errors (blocks submission per §7).
 */
export function saveContext(storage, fields) {
  const normalized = {};
  const errors = {};
  for (const { key } of CONTEXT_FIELDS) {
    const value = typeof fields?.[key] === 'string' ? fields[key] : '';
    const result = validateContextField(value);
    normalized[key] = value;
    if (!result.ok) errors[key] = result.error;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  storage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(normalized));
  return { ok: true, errors: {} };
}

/**
 * Mount the context-upload panel into root. Shows a visible per-field
 * validation message when over cap, blocks the save action, and restores
 * previously saved text (localStorage survives page reloads). Returns
 * { destroy() } which unmounts the panel.
 */
export function mountContextPanel(root, { storage = globalThis.localStorage } = {}) {
  const panel = document.createElement('section');
  panel.dataset.testid = 'context-panel';

  const heading = document.createElement('h2');
  heading.textContent = 'Konteks Wawancara';
  panel.append(heading);

  const inputs = {};
  const errorEls = {};
  for (const { key, label } of CONTEXT_FIELDS) {
    const fieldLabel = document.createElement('label');
    fieldLabel.htmlFor = `context-${key}`;
    fieldLabel.textContent = label;

    const textarea = document.createElement('textarea');
    textarea.id = `context-${key}`;
    textarea.dataset.field = key;

    const error = document.createElement('p');
    error.id = `context-${key}-error`;
    error.dataset.errorFor = key;
    error.hidden = true;
    error.setAttribute('role', 'alert');

    textarea.setAttribute('aria-describedby', error.id);
    textarea.addEventListener('input', () => {
      const result = validateContextField(textarea.value);
      error.textContent = result.ok ? '' : result.error;
      error.hidden = result.ok;
    });

    inputs[key] = textarea;
    errorEls[key] = error;
    panel.append(fieldLabel, textarea, error);
  }

  const status = document.createElement('p');
  status.dataset.status = 'context';
  status.setAttribute('role', 'status');
  panel.append(status);

  const saved = loadContext(storage);
  for (const { key } of CONTEXT_FIELDS) inputs[key].value = saved[key];

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Simpan';
  button.addEventListener('click', () => {
    const fields = {};
    for (const { key } of CONTEXT_FIELDS) fields[key] = inputs[key].value;
    const result = saveContext(storage, fields);
    for (const { key } of CONTEXT_FIELDS) {
      const message = result.errors[key] ?? '';
      errorEls[key].textContent = message;
      errorEls[key].hidden = message === '';
    }
    status.textContent = result.ok ? 'Tersimpan' : '';
    if (!result.ok) inputs[Object.keys(result.errors)[0]]?.focus();
  });
  panel.append(button);

  root.replaceChildren(panel);
  return {
    destroy() {
      root.replaceChildren();
    },
  };
}

/**
 * Mount the token-access panel into root (knowledge §5): masked bearer-token
 * input with save/clear actions and a status line telling whether a token is
 * stored. A saved token is never echoed back to the screen — only its
 * presence. Returns { destroy() } which unmounts the panel.
 */
export function mountAuthPanel(root) {
  const panel = document.createElement('section');
  panel.dataset.testid = 'auth-panel';

  const heading = document.createElement('h2');
  heading.textContent = 'Akses API';
  panel.append(heading);

  const hint = document.createElement('p');
  hint.textContent = 'Isi dengan nilai BASIC_AUTH_TOKEN di server; dipakai untuk semua request /api/*.';
  panel.append(hint);

  const label = document.createElement('label');
  label.htmlFor = 'auth-token';
  label.textContent = 'Token akses';

  const input = document.createElement('input');
  input.type = 'password';
  input.id = 'auth-token';
  input.dataset.testid = 'auth-token';
  input.autocomplete = 'off';

  const error = document.createElement('p');
  error.dataset.testid = 'auth-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');

  const status = document.createElement('p');
  status.dataset.testid = 'auth-status';
  status.setAttribute('role', 'status');

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.dataset.testid = 'auth-save';
  saveButton.textContent = 'Simpan';

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.dataset.testid = 'auth-clear';
  clearButton.textContent = 'Hapus';

  saveButton.addEventListener('click', () => {
    const value = input.value.trim();
    if (!value) {
      error.textContent = 'Token tidak boleh kosong';
      error.hidden = false;
      status.textContent = '';
      input.focus();
      return;
    }
    setStoredAuthToken(value);
    input.value = ''; // token tidak pernah ditampilkan kembali setelah disimpan
    error.hidden = true;
    status.textContent = 'Token tersimpan';
  });

  clearButton.addEventListener('click', () => {
    setStoredAuthToken(null);
    input.value = '';
    error.hidden = true;
    status.textContent = 'Token dihapus';
  });

  status.textContent = getStoredAuthToken() ? 'Token tersimpan' : 'Token belum diisi';

  panel.append(label, input, error, status, saveButton, clearButton);
  root.replaceChildren(panel);
  return {
    destroy() {
      root.replaceChildren();
    },
  };
}

/**
 * System prompt for "Steer AI" (knowledge §7): rephrase/polish ONLY the
 * user's own rough points — the model must never add new claims, facts,
 * examples, statistics, or commitments.
 */
export const STEER_SYSTEM_PROMPT =
  'You are "Steer AI", a response-drafting assistant. Rephrase and polish ONLY the rough points the user provides. ' +
  "Never introduce new claims, facts, examples, statistics, or commitments that are not already present in the user's points. " +
  'If a point is vague, preserve its original meaning instead of inventing detail. ' +
  "Keep the same language as the user's points and output only the drafted response text.";

/**
 * Draft a response from the user's rough points via POST /api/chat.
 * Resolves with { text, provider, raw }; rejects with ProvidersError
 * (including VALIDATION for empty input).
 */
export async function draftSteer(points, options = {}) {
  const text = typeof points === 'string' ? points.trim() : '';
  if (!text) {
    throw new ProvidersError('Poin tidak boleh kosong', { code: 'VALIDATION', endpoint: '/api/chat' });
  }
  return chat(
    [
      { role: 'system', content: STEER_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    options,
  );
}

/**
 * Mount the "Steer AI" drafting panel into root: rough-points textarea,
 * submit action, rendered output with a visible copy action, and inline
 * status/error messages (all via textContent — knowledge §6). Returns
 * { destroy() } which unmounts the panel.
 */
export function mountSteerPanel(root, { fetchFn, ...chatOptions } = {}) {
  const panel = document.createElement('section');
  panel.dataset.testid = 'steer-panel';

  const heading = document.createElement('h2');
  heading.textContent = 'Steer AI — Penyusun Respons';
  panel.append(heading);

  const label = document.createElement('label');
  label.htmlFor = 'steer-points';
  label.textContent = 'Poin kasar';

  const textarea = document.createElement('textarea');
  textarea.id = 'steer-points';
  textarea.dataset.testid = 'steer-points';

  const error = document.createElement('p');
  error.dataset.testid = 'steer-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');

  const status = document.createElement('p');
  status.dataset.testid = 'steer-status';
  status.setAttribute('role', 'status');

  const output = document.createElement('div');
  output.dataset.testid = 'steer-output';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.dataset.testid = 'steer-copy';
  copyButton.textContent = 'Salin';
  copyButton.hidden = true; // muncul hanya setelah ada hasil

  const submitButton = document.createElement('button');
  submitButton.type = 'button';
  submitButton.dataset.testid = 'steer-submit';
  submitButton.textContent = 'Susun';

  submitButton.addEventListener('click', async () => {
    submitButton.disabled = true;
    error.hidden = true;
    status.textContent = 'Menyusun...';
    try {
      const result = await draftSteer(textarea.value, { fetchFn, ...chatOptions });
      output.textContent = result.text;
      copyButton.hidden = false;
      status.textContent = `Disusun oleh ${result.provider}`;
    } catch (err) {
      output.textContent = '';
      copyButton.hidden = true;
      error.textContent = err?.message || 'Gagal menyusun respons';
      error.hidden = false;
      status.textContent = '';
    } finally {
      submitButton.disabled = false;
    }
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.textContent);
      status.textContent = 'Tersalin';
      error.hidden = true;
    } catch {
      error.textContent = 'Gagal menyalin — teks tetap bisa disalin manual dari kotak hasil';
      error.hidden = false;
    }
  });

  panel.append(label, textarea, submitButton, status, output, copyButton, error);
  root.replaceChildren(panel);
  return {
    destroy() {
      root.replaceChildren();
    },
  };
}

// ── Mode Latihan Interview (Task #011, knowledge §7) ─────────────────────

/** Practice-mode phases: idle → answering → feedback-pending → feedback (knowledge §7). */
export const PRACTICE_PHASE = Object.freeze({
  IDLE: 'idle',
  ANSWERING: 'answering',
  FEEDBACK_PENDING: 'feedback-pending',
  FEEDBACK: 'feedback',
});

/** Create a fresh practice session: no question, answer, or feedback yet. */
export function createPracticeSession() {
  return { phase: PRACTICE_PHASE.IDLE, question: '', answer: '', feedback: '' };
}

/**
 * Apply a practice event to the session (knowledge §7 flow order). Returns
 * the session unchanged when the event is illegal in the current phase —
 * feedback is only ever accepted after ANSWER_MARKED_COMPLETE, never while
 * the answer is still being written.
 */
export function applyPracticeEvent(session, event) {
  switch (event?.type) {
    case 'QUESTION_RECEIVED':
      if (session.phase !== PRACTICE_PHASE.IDLE) return session;
      if (typeof event.question !== 'string' || event.question.trim() === '') return session;
      return { ...session, phase: PRACTICE_PHASE.ANSWERING, question: event.question, answer: '', feedback: '' };
    case 'ANSWER_CHANGED':
      if (session.phase !== PRACTICE_PHASE.ANSWERING) return session;
      return { ...session, answer: typeof event.answer === 'string' ? event.answer : '' };
    case 'ANSWER_MARKED_COMPLETE':
      if (session.phase !== PRACTICE_PHASE.ANSWERING || session.answer.trim() === '') return session;
      return { ...session, phase: PRACTICE_PHASE.FEEDBACK_PENDING };
    case 'FEEDBACK_RECEIVED':
      if (session.phase !== PRACTICE_PHASE.FEEDBACK_PENDING) return session;
      if (typeof event.feedback !== 'string') return session;
      return { ...session, phase: PRACTICE_PHASE.FEEDBACK, feedback: event.feedback };
    case 'RESET':
      return createPracticeSession();
    default:
      return session;
  }
}

/**
 * Assemble the CV + JD prompt context, clamped field-by-field to Task #008's
 * MAX_CONTEXT_CHARS cap (knowledge §7) so a stale over-cap stored value can
 * never reach a prompt above the limit.
 */
export function buildPracticeContext(context) {
  const clamp = (value) => {
    const text = typeof value === 'string' ? value : '';
    return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text;
  };
  return { cv: clamp(context?.cv), jd: clamp(context?.jd) };
}

/**
 * Interviewer system prompt (knowledge §7): ask ONE question at a time from
 * the CV/JD; the AI is the interviewer only and must never supply an answer
 * the user could read out during a real interview.
 */
export const PRACTICE_QUESTION_SYSTEM_PROMPT =
  'You are the interviewer in interview-practice mode. Using ONLY the candidate CV and job description below, ' +
  'ask exactly ONE interview question at a time, in the same language as the job description. ' +
  'Never answer your own questions, never reveal a model answer, and never give feedback — you are the interviewer, ' +
  'not a source of answers. Output only the question text.';

/**
 * Coach system prompt (knowledge §7): feedback on clarity, relevance, and
 * language AFTER the answer is marked complete — never a verbatim answer.
 */
export const PRACTICE_FEEDBACK_SYSTEM_PROMPT =
  'You are an interview coach giving feedback after the practice answer is complete. ' +
  'Evaluate clarity, relevance, and language quality, and suggest concrete improvements. ' +
  'Never write a model answer or a verbatim solution the candidate could read during a real interview. ' +
  'Output only the feedback text.';

/** Build the /api/chat messages that ask one interview question from CV+JD context. */
export function buildQuestionMessages(context) {
  const { cv, jd } = buildPracticeContext(context);
  return [
    {
      role: 'system',
      content: `${PRACTICE_QUESTION_SYSTEM_PROMPT}\n\nCandidate CV:\n${cv}\n\nJob description:\n${jd}`,
    },
    { role: 'user', content: 'Ajukan satu pertanyaan interview.' },
  ];
}

/** Build the /api/chat messages that grade a marked-complete answer against CV+JD context. */
export function buildFeedbackMessages(session, context) {
  const { cv, jd } = buildPracticeContext(context);
  return [
    {
      role: 'system',
      content: `${PRACTICE_FEEDBACK_SYSTEM_PROMPT}\n\nCandidate CV:\n${cv}\n\nJob description:\n${jd}`,
    },
    { role: 'user', content: `Pertanyaan: ${session.question}\nJawaban peserta: ${session.answer}` },
  ];
}

/** Fetch one practice question via POST /api/chat; resolves { text, provider, raw }. */
export function requestPracticeQuestion(context, options = {}) {
  return chat(buildQuestionMessages(context), options);
}

/**
 * Fetch feedback via POST /api/chat for the current session (knowledge §7).
 * Rejects with ProvidersError VALIDATION — before any network call — unless
 * the session was explicitly marked complete.
 */
export async function requestPracticeFeedback(session, context, options = {}) {
  if (session?.phase !== PRACTICE_PHASE.FEEDBACK_PENDING) {
    throw new ProvidersError('Feedback hanya tersedia setelah jawaban ditandai selesai', {
      code: 'VALIDATION',
      endpoint: '/api/chat',
    });
  }
  return chat(buildFeedbackMessages(session, context), options);
}

/**
 * Mount the interview-practice panel into root (knowledge §7): AI question
 * derived from the saved CV+JD, a written answer the user marks complete,
 * and a feedback area that stays hidden — and is never requested over the
 * network — until that mark. Returns { destroy() } which unmounts it.
 */
export function mountPracticePanel(root, { fetchFn, storage = globalThis.localStorage, ...chatOptions } = {}) {
  const panel = document.createElement('section');
  panel.dataset.testid = 'practice-panel';

  const heading = document.createElement('h2');
  heading.textContent = 'Latihan Interview';
  panel.append(heading);

  const hint = document.createElement('p');
  hint.textContent = 'AI mengajukan satu pertanyaan berdasarkan CV + JD. Feedback hanya muncul setelah jawaban ditandai selesai.';
  panel.append(hint);

  const question = document.createElement('div');
  question.dataset.testid = 'practice-question';

  const label = document.createElement('label');
  label.htmlFor = 'practice-answer';
  label.textContent = 'Jawaban Anda';

  const answer = document.createElement('textarea');
  answer.id = 'practice-answer';
  answer.dataset.testid = 'practice-answer';

  const markButton = document.createElement('button');
  markButton.type = 'button';
  markButton.dataset.testid = 'practice-mark';
  markButton.textContent = 'Tandai selesai';
  markButton.disabled = true;

  const feedback = document.createElement('div');
  feedback.dataset.testid = 'practice-feedback';
  feedback.hidden = true; // tidak pernah tampil sebelum jawaban ditandai selesai

  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.dataset.testid = 'practice-start';
  startButton.textContent = 'Mulai latihan';

  const status = document.createElement('p');
  status.dataset.testid = 'practice-status';
  status.setAttribute('role', 'status');

  const error = document.createElement('p');
  error.dataset.testid = 'practice-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');

  let session = createPracticeSession();
  let pending = false; // true selama request chat berjalan (anti double-click)

  /** Sync the DOM with the session — the only place feedback visibility changes. */
  const render = () => {
    question.textContent = session.question;
    if (answer.value !== session.answer) answer.value = session.answer;
    feedback.textContent = session.feedback;
    feedback.hidden = session.phase !== PRACTICE_PHASE.FEEDBACK;
    answer.readOnly = session.phase !== PRACTICE_PHASE.ANSWERING;
    const canMark =
      (session.phase === PRACTICE_PHASE.ANSWERING && session.answer.trim() !== '') ||
      session.phase === PRACTICE_PHASE.FEEDBACK_PENDING; // gagal-fetch → boleh coba ulang
    markButton.disabled = pending || !canMark;
    startButton.disabled = pending || (session.phase !== PRACTICE_PHASE.IDLE && session.phase !== PRACTICE_PHASE.FEEDBACK);
  };

  startButton.addEventListener('click', async () => {
    if (startButton.disabled) return;
    pending = true;
    error.hidden = true;
    status.textContent = 'Menyiapkan pertanyaan...';
    session = applyPracticeEvent(session, { type: 'RESET' });
    render();
    try {
      const result = await requestPracticeQuestion(loadContext(storage), { fetchFn, ...chatOptions });
      session = applyPracticeEvent(session, { type: 'QUESTION_RECEIVED', question: result.text });
      status.textContent = `Pertanyaan dari ${result.provider}`;
    } catch (err) {
      error.textContent = err?.message || 'Gagal memuat pertanyaan';
      error.hidden = false;
      status.textContent = '';
    } finally {
      pending = false;
      render();
    }
  });

  answer.addEventListener('input', () => {
    session = applyPracticeEvent(session, { type: 'ANSWER_CHANGED', answer: answer.value });
    render();
  });

  markButton.addEventListener('click', async () => {
    if (markButton.disabled) return;
    if (session.phase === PRACTICE_PHASE.ANSWERING) {
      const marked = applyPracticeEvent(session, { type: 'ANSWER_MARKED_COMPLETE' });
      if (marked === session) return; // gate menahan permintaan feedback
      session = marked;
    }
    if (session.phase !== PRACTICE_PHASE.FEEDBACK_PENDING) return; // hanya setelah ditandai selesai
    pending = true;
    error.hidden = true;
    status.textContent = 'Menyiapkan feedback...';
    render();
    try {
      const result = await requestPracticeFeedback(session, loadContext(storage), { fetchFn, ...chatOptions });
      session = applyPracticeEvent(session, { type: 'FEEDBACK_RECEIVED', feedback: result.text });
      status.textContent = `Feedback dari ${result.provider}`;
    } catch (err) {
      error.textContent = err?.message || 'Gagal memuat feedback';
      error.hidden = false;
      status.textContent = '';
    } finally {
      pending = false;
      render();
    }
  });

  panel.append(question, label, answer, markButton, feedback, startButton, status, error);
  root.replaceChildren(panel);
  render();
  return {
    destroy() {
      root.replaceChildren();
    },
  };
}

/**
 * Browser bootstrap: mount the token-access, context-upload, Steer AI, and
 * interview-practice panels into the app root (defaults to #app). Called once
 * by index.html's module entry.
 */
export function initApp(root = document.getElementById('app'), options = {}) {
  if (!root) throw new Error('initApp: root element #app not found');
  const authRoot = document.createElement('div');
  const contextRoot = document.createElement('div');
  const steerRoot = document.createElement('div');
  const practiceRoot = document.createElement('div');
  root.replaceChildren(authRoot, contextRoot, steerRoot, practiceRoot);
  mountAuthPanel(authRoot);
  mountContextPanel(contextRoot, options);
  mountSteerPanel(steerRoot, options);
  mountPracticePanel(practiceRoot, options);
  return {
    destroy() {
      root.replaceChildren();
    },
  };
}
