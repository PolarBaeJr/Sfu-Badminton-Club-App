import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The receipt OCR must never send a member's browser to a third party.
// tesseract.js defaults its worker, core and language paths to a public CDN;
// ocr.ts overrides all three with /tesseract/, served from public/. This pins
// both halves: no URL in the source, and the files it names are committed.

const APP = join(__dirname, '..', '..', '..');
const source = readFileSync(join(APP, 'src', 'app', 'membership', 'ocr.ts'), 'utf8');

describe('membership OCR is self-hosted', () => {
  it('names no remote host', () => {
    for (const needle of ['jsdelivr', 'unpkg', 'http:', 'https:', 'tessdata.projectnaptha']) {
      expect(source.toLowerCase(), needle).not.toContain(needle);
    }
  });

  it('points every tesseract path at /tesseract/', () => {
    expect(source).toContain("workerPath: '/tesseract/worker.min.js'");
    expect(source).toContain("corePath: '/tesseract/'");
    expect(source).toContain("langPath: '/tesseract/'");
    expect(source).toContain('workerBlobURL: false');
  });

  it.each([
    'worker.min.js',
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
    'eng.traineddata.gz',
  ])('ships public/tesseract/%s', (name) => {
    expect(statSync(join(APP, 'public', 'tesseract', name)).size).toBeGreaterThan(0);
  });
});
