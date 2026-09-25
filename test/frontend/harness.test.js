import { describe, expect, it, beforeEach } from 'vitest';

describe('frontend test harness (jsdom)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('has DOM and localStorage available via jsdom', () => {
    expect(typeof document).toBe('object');
    localStorage.setItem('probe', 'ok');
    expect(localStorage.getItem('probe')).toBe('ok');
  });

  it('is isolated between tests: localStorage does not leak from the previous test', () => {
    expect(localStorage.getItem('probe')).toBeNull();
  });
});
