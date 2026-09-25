// Tests for public/config.js + public/app.js (Task #008) — context cap
// enforcement, localStorage persistence, and the mounted upload panel.
// Isolation: localStorage cleared before AND after every test (knowledge §4).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CONTEXT_CHARS } from '../../public/config.js';
import {
  CONTEXT_FIELDS,
  CONTEXT_STORAGE_KEY,
  initApp,
  loadContext,
  mountContextPanel,
  saveContext,
  validateContextField,
} from '../../public/app.js';

const CAP_STRING = 'x'.repeat(MAX_CONTEXT_CHARS);

let root;

const getError = (key) => root.querySelector(`[data-error-for="${key}"]`);
const getStatus = () => root.querySelector('[data-status="context"]');

beforeEach(() => {
  localStorage.clear(); // isolation: state test sebelumnya tidak boleh bocor
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  localStorage.clear();
  root.remove();
});

describe('config + context upload (Task #008)', () => {
  it('MAX_CONTEXT_CHARS is 5000 per knowledge §7', () => {
    expect(MAX_CONTEXT_CHARS).toBe(5000);
  });

  it('validateContextField accepts text at the cap and rejects text over it', () => {
    expect(validateContextField(CAP_STRING)).toMatchObject({ ok: true, length: MAX_CONTEXT_CHARS });
    expect(validateContextField(`${CAP_STRING}x`)).toMatchObject({ ok: false });
    expect(validateContextField(`${CAP_STRING}x`).error).toContain(String(MAX_CONTEXT_CHARS));
    expect(validateContextField('')).toMatchObject({ ok: true });
    expect(validateContextField(null)).toMatchObject({ ok: true });
  });

  it('saveContext blocks an over-cap field without writing anything (all-or-nothing)', () => {
    const fields = { cv: `${CAP_STRING}x`, jd: 'ok', productKnowledge: 'ok' };

    const result = saveContext(localStorage, fields);

    expect(result.ok).toBe(false);
    expect(result.errors.cv).toBeTruthy();
    expect(localStorage.getItem(CONTEXT_STORAGE_KEY)).toBeNull(); // tidak ada tulisan parsial
  });

  it('saveContext persists every field and loadContext round-trips it', () => {
    const fields = { cv: 'cv text', jd: 'jd text', productKnowledge: 'pk text' };

    expect(saveContext(localStorage, fields)).toEqual({ ok: true, errors: {} });
    expect(loadContext(localStorage)).toEqual(fields);
  });

  it('loadContext tolerates empty and corrupted storage', () => {
    expect(loadContext(localStorage)).toEqual({ cv: '', jd: '', productKnowledge: '' });
    localStorage.setItem(CONTEXT_STORAGE_KEY, '{not json');
    expect(loadContext(localStorage)).toEqual({ cv: '', jd: '', productKnowledge: '' });
    localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify({ cv: 'only-cv', unexpected: 1 }));
    expect(loadContext(localStorage)).toEqual({ cv: 'only-cv', jd: '', productKnowledge: '' });
  });

  it('typing over the cap shows a visible validation message and blocks the save action', () => {
    mountContextPanel(root, { storage: localStorage });
    const textarea = root.querySelector('[data-field="cv"]');

    textarea.value = `${CAP_STRING}x`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(getError('cv').hidden).toBe(false); // visible
    expect(getError('cv').textContent).toContain(String(MAX_CONTEXT_CHARS));

    root.querySelector('button').click();

    expect(localStorage.getItem(CONTEXT_STORAGE_KEY)).toBeNull(); // save blocked
    expect(getError('cv').hidden).toBe(false);
    expect(getStatus().textContent).toBe(''); // tidak ada status "Tersimpan"
  });

  it('valid text saves from the panel and persists across a simulated reload', () => {
    mountContextPanel(root, { storage: localStorage });
    root.querySelector('[data-field="cv"]').value = 'my cv content';
    root.querySelector('[data-field="jd"]').value = 'my jd content';
    root.querySelector('button').click();

    expect(getStatus().textContent).toBe('Tersimpan');
    expect(JSON.parse(localStorage.getItem(CONTEXT_STORAGE_KEY))).toMatchObject({
      cv: 'my cv content',
      jd: 'my jd content',
    });

    // simulated reload: fresh mount from the same storage repopulates every field
    root.replaceChildren();
    mountContextPanel(root, { storage: localStorage });
    expect(root.querySelector('[data-field="cv"]').value).toBe('my cv content');
    expect(root.querySelector('[data-field="jd"]').value).toBe('my jd content');
    expect(root.querySelector('[data-field="productKnowledge"]').value).toBe('');
  });

  it('renders one labeled textarea + error slot per context field', () => {
    mountContextPanel(root, { storage: localStorage });

    expect(root.querySelectorAll('textarea')).toHaveLength(CONTEXT_FIELDS.length);
    for (const { key, label } of CONTEXT_FIELDS) {
      const textarea = root.querySelector(`[data-field="${key}"]`);
      expect(textarea).toBeTruthy();
      expect(root.querySelector(`label[for="context-${key}"]`).textContent).toBe(label);
      expect(getError(key)).toBeTruthy();
    }
  });

  it('destroy() unmounts the panel', () => {
    const handle = mountContextPanel(root, { storage: localStorage });
    expect(root.querySelector('[data-testid="context-panel"]')).toBeTruthy();

    handle.destroy();

    expect(root.querySelector('[data-testid="context-panel"]')).toBeNull();
  });

  it('initApp mounts into #app and throws a clear error when the root is missing', () => {
    const appRoot = document.createElement('div');
    appRoot.id = 'app';
    document.body.append(appRoot);

    const handle = initApp(appRoot, { storage: localStorage });
    expect(appRoot.querySelector('[data-testid="context-panel"]')).toBeTruthy();
    handle.destroy();
    appRoot.remove();

    expect(() => initApp(null)).toThrow('#app');
  });
});
