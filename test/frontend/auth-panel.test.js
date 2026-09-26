// Tests for the token-access panel (Task #010B) — public/app.js
// mountAuthPanel: masked input + save/clear, token persisted via
// providers.js setStoredAuthToken (knowledge §5), and never echoed back.
// Isolation: localStorage cleared in beforeEach AND afterEach, one fresh
// root element per test, removed in afterEach.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initApp, mountAuthPanel } from '../../public/app.js';
import { AUTH_TOKEN_STORAGE_KEY, getStoredAuthToken } from '../../public/providers.js';

let root;

const byTestid = (id) => root.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.clear();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  localStorage.clear();
  root.remove();
});

describe('auth token panel (Task #010B)', () => {
  it('renders a masked input with save/clear actions and an initial status', () => {
    mountAuthPanel(root);

    const input = byTestid('auth-token');
    expect(input).toBeTruthy();
    expect(input.type).toBe('password');
    expect(byTestid('auth-save').textContent).toBe('Simpan');
    expect(byTestid('auth-clear').textContent).toBe('Hapus');
    expect(byTestid('auth-status').textContent).toBe('Token belum diisi');
    expect(byTestid('auth-error').hidden).toBe(true);
  });

  it('saving stores the token in localStorage, clears the input, and never echoes it back', () => {
    mountAuthPanel(root);
    const input = byTestid('auth-token');
    input.value = 'rahasia-123';
    byTestid('auth-save').click();

    expect(getStoredAuthToken()).toBe('rahasia-123');
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('rahasia-123');
    expect(input.value).toBe('');
    expect(byTestid('auth-status').textContent).toBe('Token tersimpan');
    expect(byTestid('auth-error').hidden).toBe(true);
    expect(root.textContent).not.toContain('rahasia-123'); // tidak pernah tampil di layar
  });

  it('rejects an empty/whitespace token with a visible message and writes nothing', () => {
    mountAuthPanel(root);
    byTestid('auth-token').value = '   ';
    byTestid('auth-save').click();

    expect(getStoredAuthToken()).toBeNull(); // storage tidak tersentuh
    const error = byTestid('auth-error');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('kosong');
    expect(byTestid('auth-status').textContent).toBe('');
  });

  it('clearing removes the stored token and reports it', () => {
    mountAuthPanel(root);
    byTestid('auth-token').value = 'rahasia-123';
    byTestid('auth-save').click();
    byTestid('auth-clear').click();

    expect(getStoredAuthToken()).toBeNull();
    expect(byTestid('auth-token').value).toBe('');
    expect(byTestid('auth-status').textContent).toBe('Token dihapus');
  });

  it('reports an already-stored token on mount without displaying its value', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token-lama');

    mountAuthPanel(root);

    expect(byTestid('auth-status').textContent).toBe('Token tersimpan');
    expect(root.textContent).not.toContain('token-lama');
    expect(byTestid('auth-token').value).toBe('');
  });

  it('initApp mounts the auth panel alongside context and steer panels with composite destroy', () => {
    const appRoot = document.createElement('div');
    document.body.append(appRoot);

    const handle = initApp(appRoot, { storage: localStorage });
    expect(appRoot.querySelector('[data-testid="auth-panel"]')).toBeTruthy();
    expect(appRoot.querySelector('[data-testid="context-panel"]')).toBeTruthy(); // #008 tetap terpasang
    expect(appRoot.querySelector('[data-testid="steer-panel"]')).toBeTruthy();

    handle.destroy();
    expect(appRoot.querySelector('[data-testid="auth-panel"]')).toBeNull();
    appRoot.remove();
  });
});
