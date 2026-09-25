// public/app.js — UI entry point: context-upload panel (CV / job description /
// product knowledge) with client-side 5,000-char cap enforcement and
// localStorage persistence (knowledge §7). Side-effect free: the browser
// bootstraps via initApp(); tests mount panels directly.

import { MAX_CONTEXT_CHARS } from './config.js';

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
 * Browser bootstrap: mount the context panel into the app root
 * (defaults to #app). Called once by index.html's module entry.
 */
export function initApp(root = document.getElementById('app'), options = {}) {
  if (!root) throw new Error('initApp: root element #app not found');
  return mountContextPanel(root, options);
}
