'use client';

import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

// In-app QR scanning, decoded on-device.
//
// Uses BarcodeDetector where it exists (Chrome/Android — hardware-accelerated,
// far cheaper than decoding frames in JS) and falls back to jsQR everywhere
// else. The fallback is not optional: BarcodeDetector is still absent from
// Safari, so without it this feature would be broken for most of an iPhone-
// heavy club.
//
// Nothing leaves the device. Frames are drawn to an offscreen canvas, decoded,
// and discarded — no upload, no recording.

type Detected = { rawValue: string };
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Detected[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

export function QrScanner({
  onResult,
  paused,
}: {
  onResult: (value: string) => void;
  paused?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  // A ref, not state: the scan loop closes over this and must see the current
  // value without being torn down and restarted on every frame.
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    let detector: BarcodeDetectorLike | null = null;

    async function start() {
      try {
        // facingMode 'environment' asks for the rear camera. Not exact: a
        // laptop with only a front camera should still work rather than throw.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch (err) {
        setStarting(false);
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera access was denied. Allow it in your browser settings, or ask an exec to check you in.'
            : 'No camera available on this device.',
        );
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      // playsInline matters on iOS — without it Safari takes the video
      // fullscreen and the surrounding UI disappears.
      video.setAttribute('playsinline', 'true');
      await video.play().catch(() => undefined);
      setStarting(false);

      if (typeof window !== 'undefined' && window.BarcodeDetector) {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch {
          detector = null; // constructor can throw if qr_code is unsupported
        }
      }

      const tick = async () => {
        if (stopped.current) return;
        const canvas = canvasRef.current;
        if (video.readyState === video.HAVE_ENOUGH_DATA && canvas) {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (w && h) {
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, w, h);
              let value: string | null = null;
              if (detector) {
                try {
                  const found = await detector.detect(canvas);
                  value = found[0]?.rawValue ?? null;
                } catch {
                  detector = null; // fall through to jsQR from here on
                }
              }
              if (!value) {
                const img = ctx.getImageData(0, 0, w, h);
                value = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
              }
              if (value) {
                stopped.current = true;
                onResult(value);
                return;
              }
            }
          }
        }
        raf = requestAnimationFrame(() => void tick());
      };
      void tick();
    }

    void start();

    return () => {
      stopped.current = true;
      cancelAnimationFrame(raf);
      // Releasing every track matters: leaving one open keeps the camera
      // indicator lit after navigating away, which reads as the app spying.
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  // Freeze scanning while the parent is submitting, without tearing the camera
  // down — restarting it costs a visible second and a permission flicker.
  useEffect(() => {
    if (paused) stopped.current = true;
  }, [paused]);

  if (error) {
    return (
      <div className="card-base" role="alert">
        <p style={{ fontSize: 13, margin: 0 }}>{error}</p>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', borderRadius: 'var(--r-lg)', overflow: 'hidden', background: '#000' }}>
      <video ref={videoRef} muted playsInline style={{ width: '100%', display: 'block' }} />
      <canvas ref={canvasRef} style={{ display: 'none' }} />
      {starting && (
        <div
          style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 13 }}
          role="status"
        >
          Starting camera…
        </div>
      )}
      {/* Aiming guide. Purely visual — decoding uses the whole frame, so a code
          slightly outside the box still scans rather than mysteriously not. */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: '18%',
          border: '2px solid rgba(255,255,255,.8)', borderRadius: 12, pointerEvents: 'none',
        }}
      />
    </div>
  );
}
