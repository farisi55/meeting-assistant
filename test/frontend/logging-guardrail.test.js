import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guardrail source-scan: aturan no-PII-logging dari CONTRIBUTING.md /
// knowledge §8 dijadikan test supaya tidak hanya "aturan di dokumen".
// Diletakkan di project frontend (runtime Node/jsdom) karena project
// worker berjalan di workerd tanpa akses filesystem.
// Path di-resolve dari cwd (= root project saat `npm test` dijalankan).
const workerSrc = readFileSync(resolve(process.cwd(), 'worker.js'), 'utf8');

// Buang komentar dulu supaya komentar guard itu sendiri (yang memang
// menyebut "console.*" dan nama kredensial sebagai contoh yang DILARANG)
// tidak ikut terdeteksi sebagai pelanggaran.
const codeOnly = workerSrc
  .split('\n')
  .map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
    return line.replace(/\/\/.*$/, '');
  })
  .join('\n');

// Token yang menandakan konten terlarang: body/transcript/kredensial.
const FORBIDDEN = [
  'body',
  'messages',
  'transcript',
  'Authorization',
  'BASIC_AUTH_',
  'API_KEY',
  'apiKey',
  'password',
  'decoded',
  'encoded',
];

describe('no-PII-logging guardrail (Task #004)', () => {
  // Semua test hanya membaca file secara read-only — tidak ada state yang
  // dibuat, dimodifikasi, atau dibagikan antar test (isolated by design).

  it('has no console.* call in worker.js referencing request/transcript/credential content', () => {
    const consoleLines = codeOnly
      .split('\n')
      .filter((line) => line.includes('console.'));
    for (const line of consoleLines) {
      for (const token of FORBIDDEN) {
        expect(line, `console.* ilegal di worker.js: ${line.trim()}`).not.toContain(token);
      }
    }
  });

  it('keeps the PII-SAFE LOGGING guard at the top of checkAuth, handleChat, and handleTranscribe', () => {
    for (const fn of ['checkAuth', 'handleChat', 'handleTranscribe']) {
      const idx = workerSrc.indexOf(`function ${fn}(`);
      expect(idx, `fungsi ${fn} tidak ditemukan di worker.js`).toBeGreaterThan(-1);
      expect(
        workerSrc.slice(idx, idx + 400),
        `guard PII-SAFE LOGGING hilang dari ${fn}`,
      ).toContain('PII-SAFE LOGGING');
    }
  });

  it('documents the no-PII-logging rule in CONTRIBUTING.md', () => {
    const doc = readFileSync(resolve(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
    expect(doc).toContain('console.log');
    expect(doc).toContain('BASIC_AUTH_PASS');
    expect(doc).toContain('transkrip');
    expect(doc).toContain('logging-guardrail');
  });
});
