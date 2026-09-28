// Tests for the interview-practice mode (Task #011, knowledge §7) — the
// state-machine gate "no feedback before the answer is marked complete",
// CV/JD context assembly under Task #008's 5,000-char cap, and panel wiring
// with a mocked fetchFn (no live network).
// Isolation: fresh root per test, localStorage cleared in both hooks,
// per-test fetchFn closure, session created fresh inside each test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRACTICE_FEEDBACK_SYSTEM_PROMPT,
  PRACTICE_PHASE,
  PRACTICE_QUESTION_SYSTEM_PROMPT,
  applyPracticeEvent,
  buildPracticeContext,
  createPracticeSession,
  initApp,
  mountPracticePanel,
  requestPracticeFeedback,
  requestPracticeQuestion,
} from '../../public/app.js';
import { MAX_CONTEXT_CHARS } from '../../public/config.js';

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
    return impl(calls.length, ...args);
  };
  fn.calls = calls;
  return fn;
};

/** Reach the state where an answer exists but has NOT been marked complete. */
const answeringSession = (answer = 'jawaban saya') =>
  applyPracticeEvent(
    applyPracticeEvent(createPracticeSession(), { type: 'QUESTION_RECEIVED', question: 'Apa pengalaman Anda?' }),
    { type: 'ANSWER_CHANGED', answer },
  );

const markedSession = (answer = 'jawaban saya') =>
  applyPracticeEvent(answeringSession(answer), { type: 'ANSWER_MARKED_COMPLETE' });

let root;

beforeEach(() => {
  localStorage.clear();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  localStorage.clear();
  root.remove();
});

const byTestid = (id) => root.querySelector(`[data-testid="${id}"]`);
const waitFor = async (assertion) => {
  await vi.waitFor(assertion, { timeout: 1000 });
};

describe('practice state machine — no feedback before mark-complete (knowledge §7)', () => {
  it('rejects FEEDBACK_RECEIVED while answering, even with a full answer typed', () => {
    const session = answeringSession();
    expect(session.phase).toBe(PRACTICE_PHASE.ANSWERING);

    const next = applyPracticeEvent(session, { type: 'FEEDBACK_RECEIVED', feedback: 'feedback terlarang' });

    expect(next).toBe(session); // tidak berubah sama sekali
    expect(next.feedback).toBe('');
    expect(next.phase).toBe(PRACTICE_PHASE.ANSWERING);
  });

  it('rejects FEEDBACK_RECEIVED while the session is still idle', () => {
    const session = createPracticeSession();
    const next = applyPracticeEvent(session, { type: 'FEEDBACK_RECEIVED', feedback: 'x' });

    expect(next).toBe(session); // tanpa pertanyaan/jawaban, feedback mustahil diterima
    expect(next.feedback).toBe('');
    expect(next.phase).toBe(PRACTICE_PHASE.IDLE);
  });

  it('rejects ANSWER_MARKED_COMPLETE without a non-empty answer', () => {
    const session = answeringSession('   ');
    const empty = applyPracticeEvent(session, { type: 'ANSWER_MARKED_COMPLETE' });
    expect(empty).toBe(session);
    expect(empty.phase).toBe(PRACTICE_PHASE.ANSWERING);
  });

  it('accepts feedback only along the legal path: question → answer → mark → feedback', () => {
    let session = createPracticeSession();
    session = applyPracticeEvent(session, { type: 'QUESTION_RECEIVED', question: 'Ceritakan proyek Anda.' });
    expect(session.phase).toBe(PRACTICE_PHASE.ANSWERING);

    session = applyPracticeEvent(session, { type: 'ANSWER_CHANGED', answer: 'Saya membangun sistem penilaian.' });
    session = applyPracticeEvent(session, { type: 'ANSWER_MARKED_COMPLETE' });
    expect(session.phase).toBe(PRACTICE_PHASE.FEEDBACK_PENDING);

    session = applyPracticeEvent(session, { type: 'FEEDBACK_RECEIVED', feedback: 'Jelas dan relevan.' });
    expect(session.phase).toBe(PRACTICE_PHASE.FEEDBACK);
    expect(session.feedback).toBe('Jelas dan relevan.');
    expect(session.answer).toBe('Saya membangun sistem penilaian.'); // jawaban tetap tersimpan
  });

  it('illegal events are no-ops: answer typed while idle, question while answering', () => {
    const idle = createPracticeSession();
    expect(applyPracticeEvent(idle, { type: 'ANSWER_CHANGED', answer: 'x' })).toBe(idle);

    const answering = answeringSession();
    expect(applyPracticeEvent(answering, { type: 'QUESTION_RECEIVED', question: 'lain' })).toBe(answering);
  });

  it('system prompts forbid supplying a verbatim answer the user could read live', () => {
    expect(PRACTICE_QUESTION_SYSTEM_PROMPT).toMatch(/never answer your own questions/i);
    expect(PRACTICE_QUESTION_SYSTEM_PROMPT).toMatch(/never reveal a model answer/i);
    expect(PRACTICE_FEEDBACK_SYSTEM_PROMPT).toMatch(/never write a model answer/i);
  });
});

describe('practice request gating', () => {
  it('requestPracticeFeedback rejects with VALIDATION and zero network calls unless marked complete', async () => {
    const fetchFn = makeFetch(async () => okReply('tidak boleh terkirim'));

    await expect(requestPracticeFeedback(createPracticeSession(), {}, { fetchFn })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(requestPracticeFeedback(answeringSession(), {}, { fetchFn })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(requestPracticeFeedback(undefined, {}, { fetchFn })).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(fetchFn.calls).toHaveLength(0); // tidak ada panggilan /api/chat sama sekali
  });

  it('requestPracticeFeedback in feedback-pending sends question, answer, and capped CV/JD context', async () => {
    const fetchFn = makeFetch(async () => okReply('feedback dari coach', 'mistral'));
    const context = { cv: 'CV Banu', jd: 'JD frontend' };

    const result = await requestPracticeFeedback(markedSession('jawaban uji'), context, { fetchFn });

    expect(result).toMatchObject({ text: 'feedback dari coach', provider: 'mistral' });
    const [url, init] = fetchFn.calls[0];
    expect(url).toBe('/api/chat');
    const messages = JSON.parse(init.body).messages;
    expect(messages[0].content).toContain('CV Banu');
    expect(messages[0].content).toContain('JD frontend');
    expect(messages[1].content).toContain('Apa pengalaman Anda?');
    expect(messages[1].content).toContain('jawaban uji');
  });

  it('requestPracticeQuestion asks exactly one question from the CV/JD context', async () => {
    const fetchFn = makeFetch(async () => okReply('Pertanyaan satu?'));
    const context = { cv: 'CV Banu', jd: 'JD backend' };

    const result = await requestPracticeQuestion(context, { fetchFn });

    expect(result.text).toBe('Pertanyaan satu?');
    const messages = JSON.parse(fetchFn.calls[0][1].body).messages;
    expect(messages[0].content).toContain('CV Banu');
    expect(messages[0].content).toContain('JD backend');
    expect(messages[0].content).toMatch(/ONE interview question/i);
  });
});

describe('practice context assembly (Task #008 character cap)', () => {
  it('clamps each field to MAX_CONTEXT_CHARS and tolerates missing/non-string values', () => {
    const overCap = buildPracticeContext({ cv: 'x'.repeat(MAX_CONTEXT_CHARS + 250), jd: 'y'.repeat(MAX_CONTEXT_CHARS + 10) });
    expect(overCap.cv).toHaveLength(MAX_CONTEXT_CHARS);
    expect(overCap.jd).toHaveLength(MAX_CONTEXT_CHARS);

    expect(buildPracticeContext({})).toEqual({ cv: '', jd: '' });
    expect(buildPracticeContext(undefined)).toEqual({ cv: '', jd: '' });
    expect(buildPracticeContext({ cv: 42, jd: null })).toEqual({ cv: '', jd: '' });

    const under = buildPracticeContext({ cv: 'pendek', jd: 'juga pendek' });
    expect(under).toEqual({ cv: 'pendek', jd: 'juga pendek' });
  });

  it('an over-cap stored CV is truncated before it reaches the prompt', async () => {
    const fetchFn = makeFetch(async () => okReply('Pertanyaan?'));
    await requestPracticeQuestion({ cv: 'z'.repeat(MAX_CONTEXT_CHARS + 500), jd: 'jd' }, { fetchFn });

    const systemContent = JSON.parse(fetchFn.calls[0][1].body).messages[0].content;
    expect(systemContent.split('z').length - 1).toBe(MAX_CONTEXT_CHARS); // hanya MAX_CONTEXT_CHARS karakter 'z'
  });
});

describe('practice panel wiring', () => {
  it('renders no feedback and makes no feedback request before the user marks the answer complete', async () => {
    const fetchFn = makeFetch(async (n) => (n === 1 ? okReply('Pertanyaan interview pertama?') : okReply('feedback sesi')));
    mountPracticePanel(root, { fetchFn });

    expect(byTestid('practice-feedback').hidden).toBe(true);
    expect(byTestid('practice-mark').disabled).toBe(true);

    byTestid('practice-start').click();
    await waitFor(() => expect(byTestid('practice-question').textContent).toBe('Pertanyaan interview pertama?'));
    expect(fetchFn.calls).toHaveLength(1); // hanya pertanyaan
    expect(byTestid('practice-feedback').hidden).toBe(true);

    byTestid('practice-mark').click(); // jawaban masih kosong → tombol nonaktif
    expect(fetchFn.calls).toHaveLength(1);

    const answerBox = byTestid('practice-answer');
    answerBox.value = 'Saya mengerjakan proyek X dengan hasil Y.';
    answerBox.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(byTestid('practice-mark').disabled).toBe(false);
    expect(byTestid('practice-feedback').hidden).toBe(true); // mengetik tidak membuat feedback muncul
    expect(fetchFn.calls).toHaveLength(1); // belum ada panggilan feedback

    byTestid('practice-mark').click();
    await waitFor(() => expect(fetchFn.calls).toHaveLength(2));
    await waitFor(() => expect(byTestid('practice-feedback').textContent).toBe('feedback sesi'));
    expect(byTestid('practice-feedback').hidden).toBe(false); // hanya setelah ditandai selesai
    expect(answerBox.readOnly).toBe(true); // jawaban dikunci setelah ditandai
    expect(byTestid('practice-status').textContent).toContain('groq');
  });

  it('a failed feedback request keeps feedback hidden and allows a retry', async () => {
    const fetchFn = makeFetch(async (n) => {
      if (n === 1) return okReply('Pertanyaan?');
      if (n === 2) return { ok: false, status: 503, json: async () => ({}), text: async () => 'upstream down' };
      return okReply('feedback retry');
    });
    mountPracticePanel(root, { fetchFn });

    byTestid('practice-start').click();
    await waitFor(() => expect(byTestid('practice-question').textContent).toBe('Pertanyaan?'));
    const answerBox = byTestid('practice-answer');
    answerBox.value = 'jawaban yang ditandai';
    answerBox.dispatchEvent(new window.Event('input', { bubbles: true }));

    byTestid('practice-mark').click();
    await waitFor(() => expect(byTestid('practice-error').hidden).toBe(false));
    expect(byTestid('practice-error').textContent).toContain('503');
    expect(byTestid('practice-feedback').hidden).toBe(true);
    expect(byTestid('practice-feedback').textContent).toBe('');
    expect(byTestid('practice-mark').disabled).toBe(false); // masih bisa dicoba ulang

    byTestid('practice-mark').click();
    await waitFor(() => expect(byTestid('practice-feedback').textContent).toBe('feedback retry'));
    expect(byTestid('practice-feedback').hidden).toBe(false);
    expect(byTestid('practice-error').hidden).toBe(true);
    expect(fetchFn.calls).toHaveLength(3);
  });

  it('feedback renders AI output as literal text, never as parsed markup (knowledge §6)', async () => {
    const fetchFn = makeFetch(async (n) =>
      n === 1 ? okReply('Pertanyaan?') : okReply('<img src=x onerror="alert(1)"> juga <script>alert(2)</script>'),
    );
    mountPracticePanel(root, { fetchFn });

    byTestid('practice-start').click();
    await waitFor(() => expect(byTestid('practice-question').textContent).toBe('Pertanyaan?'));
    const answerBox = byTestid('practice-answer');
    answerBox.value = 'jawaban';
    answerBox.dispatchEvent(new window.Event('input', { bubbles: true }));
    byTestid('practice-mark').click();

    await waitFor(() => expect(byTestid('practice-feedback').textContent).toContain('onerror'));
    expect(byTestid('practice-feedback').querySelector('script')).toBeNull();
    expect(byTestid('practice-feedback').querySelector('img')).toBeNull();
  });

  it('question errors surface visibly and leave the panel usable', async () => {
    const fetchFn = makeFetch(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
    }));
    mountPracticePanel(root, { fetchFn });

    byTestid('practice-start').click();
    await waitFor(() => expect(byTestid('practice-error').hidden).toBe(false));
    expect(byTestid('practice-error').textContent).toContain('500');
    expect(byTestid('practice-question').textContent).toBe('');
    expect(byTestid('practice-mark').disabled).toBe(true);
    expect(byTestid('practice-start').disabled).toBe(false); // bisa mencoba lagi
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('initApp mounts the practice panel alongside the other three panels with composite destroy', () => {
    const appRoot = document.createElement('div');
    appRoot.id = 'app';
    document.body.append(appRoot);

    const handle = initApp(appRoot, { storage: localStorage });

    expect(appRoot.querySelector('[data-testid="auth-panel"]')).toBeTruthy();
    expect(appRoot.querySelector('[data-testid="context-panel"]')).toBeTruthy();
    expect(appRoot.querySelector('[data-testid="steer-panel"]')).toBeTruthy();
    expect(appRoot.querySelector('[data-testid="practice-panel"]')).toBeTruthy();

    handle.destroy();
    expect(appRoot.querySelector('[data-testid="practice-panel"]')).toBeNull();
    expect(appRoot.children).toHaveLength(0);
    appRoot.remove();
  });
});
