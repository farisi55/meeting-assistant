// Source-scan guardrails for Task #010A (Bearer token auth):
// 1. the retired Basic-auth credential vars appear nowhere in code or test
//    config (acceptance: "grep-clean"), and
// 2. the credential comparison in worker.js is the constant-time one
//    (crypto.subtle.timingSafeEqual), so a future `===` refactor fails here.
// Lives in the Node/jsdom project because the worker project runs in
// workerd without filesystem access (same rationale as logging-guardrail).
// Every read is read-only — no state created or shared (isolated by design).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const SELF = 'test/frontend/auth-guardrails.test.js';

/** Recursively collect every .js file under dir (relative to project root). */
function jsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// Code + test config + operator docs. Deliberately EXCLUDED:
// prd.md (original requirement document, historical source) and
// changelog.md (task tracker, quotes the retired names in past entries).
const SCANNED = [
  'worker.js',
  'wrangler.toml',
  '.dev.vars.example',
  'vitest.config.js',
  'vitest.worker.config.js',
  'vitest.frontend.config.js',
  'README.md',
  'CONTRIBUTING.md',
  'knowledge.md',
  ...jsFilesUnder('public'),
  ...jsFilesUnder('test'),
].map((f) => f.split('\\').join('/')) // Windows join() emits backslashes
  .filter((f) => f !== SELF);

const RETIRED = ['BASIC_AUTH_USER', 'BASIC_AUTH_PASS'];

describe('auth source guardrails (Task #010A)', () => {
  it('keeps the retired Basic-auth credential vars out of code and test config', () => {
    const offenders = [];
    for (const file of SCANNED) {
      const doc = readFileSync(resolve(root, file), 'utf8');
      for (const token of RETIRED) {
        if (doc.includes(token)) offenders.push(`${file}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('compares credentials with crypto.subtle.timingSafeEqual (constant-time)', () => {
    const src = readFileSync(resolve(root, 'worker.js'), 'utf8');
    const idx = src.indexOf('function tokensMatch(');
    expect(idx, 'tokensMatch tidak ditemukan di worker.js').toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 600)).toContain('crypto.subtle.timingSafeEqual');
  });
});
