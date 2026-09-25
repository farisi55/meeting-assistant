// public/app.js — UI entry point: context-upload panel (CV / job description /
// product knowledge) with client-side 5,000-char cap enforcement and
// localStorage persistence (knowledge §7), plus the "Steer AI" response
// drafting panel (knowledge §7). Side-effect free: the browser bootstraps
// via initApp(); tests mount panels directly.

import { MAX_CONTEXT_CHARS } from './config.js';
import { ProvidersError, chat } from './providers.js';

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

/**
 * Browser bootstrap: mount the context-upload and Steer AI panels into the
 * app root (defaults to #app). Called once by index.html's module entry.
 */
export function initApp(root = document.getElementById('app'), options = {}) {
  if (!root) throw new Error('initApp: root element #app not found');
  const contextRoot = document.createElement('div');
  const steerRoot = document.createElement('div');
  root.replaceChildren(contextRoot, steerRoot);
  mountContextPanel(contextRoot, options);
  mountSteerPanel(steerRoot, options);
  return {
    destroy() {
      root.replaceChildren();
    },
  };
}
