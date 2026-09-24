// READING THE E-TRANSFER SCREENSHOT, IN THE BROWSER.
//
// Loaded only when a member picks a screenshot (a dynamic import from
// etransfer-form.tsx), so nobody else downloads any of it.
//
// EVERYTHING IS SELF-HOSTED under /tesseract/, committed to the repo and
// pinned: the worker from tesseract.js 7.0.0, the three LSTM-only cores from
// tesseract.js-core 7.0.0 (the worker picks relaxed-SIMD, SIMD or plain by what
// the browser supports), and the English "fast" model from tessdata_fast 4.1.0,
// gzipped. Left at their defaults these paths point at a public CDN, which
// would send the member's browser to a third party; a test pins that no URL
// appears in this file.
//
// It never throws: a failure, or a read that takes too long, answers null and
// the member types the reference themselves. The worker is terminated either
// way, since it holds the model in memory.

import { extractEtransferReference, type ExtractedReference } from '@badminton/shared/src/utils/etransfer-reference';

const OCR_TIMEOUT_MS = 30_000;

export async function readReferenceFromImage(file: Blob): Promise<ExtractedReference | null> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { createWorker, OEM } = await import('tesseract.js');
    const work = (async () => {
      const worker = await createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: '/tesseract/worker.min.js',
        corePath: '/tesseract/',
        langPath: '/tesseract/',
        gzip: true,
        workerBlobURL: false,
      });
      try {
        if (timedOut) return null;
        const { data } = await worker.recognize(file);
        return extractEtransferReference(data.text);
      } finally {
        worker.terminate().catch(() => undefined);
      }
    })();
    // A late failure after the timeout has already answered is not an error.
    work.catch(() => undefined);
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, OCR_TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } catch (err) {
    console.warn('[membership] could not read the screenshot:', err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
