'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@badminton/ui';
import { ZoomIn, ZoomOut, Loader2 } from 'lucide-react';

// Side of the square we export. Avatars render at most ~96px, but 512 keeps
// them crisp on hi-dpi screens and when a future screen shows them larger.
const OUTPUT_SIZE = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

interface AvatarCropDialogProps {
  open: boolean;
  /** Object URL / data URL of the file the player picked. */
  imageSrc: string | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}

/**
 * Lets a player choose which part of their photo lands inside the avatar
 * circle: drag to pan, pinch/scroll/slider to zoom. The visible circle is the
 * crop; we export the square that circumscribes it (avatars are rendered round
 * everywhere by the `.avatar` CSS, so a square file stays reusable).
 *
 * Implemented directly on pointer events rather than pulling in a crop library
 * — it's ~1 screen of geometry and avoids a dependency in the client bundle.
 */
export function AvatarCropDialog({ open, imageSrc, busy, onCancel, onConfirm }: AvatarCropDialogProps) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  // Pan offset in *screen* px, measured from the centred position.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState(280);

  const frameRef = useRef<HTMLDivElement>(null);
  // Active pointers, so one finger pans and two fingers pinch-zoom.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureStart = useRef<{ dist: number; zoom: number } | null>(null);

  // Load the picked file and reset the transform for each new image.
  useEffect(() => {
    if (!imageSrc) { setImg(null); return; }
    const image = new Image();
    image.onload = () => {
      setImg(image);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    image.src = imageSrc;
  }, [imageSrc]);

  // The frame is fluid (min(280px, viewport-64)) so the dialog fits phones;
  // the geometry needs its real pixel size.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const w = frameRef.current?.clientWidth;
      if (w) setViewport(w);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, img]);

  // "Cover" scale: the smallest scale where the image fills the frame, so no
  // empty gaps can appear inside the circle. Zoom multiplies it.
  const baseScale = img ? Math.max(viewport / img.naturalWidth, viewport / img.naturalHeight) : 1;
  const scale = baseScale * zoom;

  // Pan limits: never let an edge cross into the frame.
  const clampOffset = useCallback(
    (next: { x: number; y: number }, atZoom: number) => {
      if (!img) return { x: 0, y: 0 };
      const s = baseScale * atZoom;
      const maxX = Math.max(0, (img.naturalWidth * s - viewport) / 2);
      const maxY = Math.max(0, (img.naturalHeight * s - viewport) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      };
    },
    [img, baseScale, viewport],
  );

  const applyZoom = useCallback(
    (next: number) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      setZoom(z);
      // Re-clamp: zooming out can leave the image off-centre past its limits.
      setOffset((o) => clampOffset(o, z));
    },
    [clampOffset],
  );

  // Distance between the two active pointers, or null unless exactly two are down.
  function pinchDistance(): number | null {
    const pts = [...pointers.current.values()];
    if (pts.length !== 2) return null;
    const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function handlePointerDown(e: React.PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const dist = pinchDistance();
    if (dist !== null) gestureStart.current = { dist, zoom };
  }

  function handlePointerMove(e: React.PointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const dist = pinchDistance();
    if (dist !== null && gestureStart.current) {
      applyZoom(gestureStart.current.zoom * (dist / gestureStart.current.dist));
      return;
    }
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    setOffset((o) => clampOffset({ x: o.x + dx, y: o.y + dy }, zoom));
  }

  function handlePointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gestureStart.current = null;
  }

  function handleWheel(e: React.WheelEvent) {
    if (!img) return;
    applyZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  }

  // Map the on-screen transform back to source-image pixels and draw that
  // square region into the export canvas.
  function handleConfirm() {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const sourceSize = viewport / scale; // frame size expressed in image px
    const cx = img.naturalWidth / 2 - offset.x / scale;
    const cy = img.naturalHeight / 2 - offset.y / scale;

    ctx.imageSmoothingQuality = 'high';
    // Fill first: a transparent PNG flattened to JPEG would otherwise go black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.drawImage(
      img,
      cx - sourceSize / 2,
      cy - sourceSize / 2,
      sourceSize,
      sourceSize,
      0,
      0,
      OUTPUT_SIZE,
      OUTPUT_SIZE,
    );

    canvas.toBlob((blob) => { if (blob) onConfirm(blob); }, 'image/jpeg', 0.9);
  }

  return (
    <Dialog open={open} onClose={busy ? () => {} : onCancel} title="Position your photo">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Drag to move, pinch or scroll to zoom. Whatever sits inside the circle becomes your
          profile picture.
        </p>

        <div
          ref={frameRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          style={{
            position: 'relative',
            width: 'min(280px, calc(100vw - 96px))',
            aspectRatio: '1 / 1',
            margin: '0 auto',
            overflow: 'hidden',
            borderRadius: 12,
            background: 'var(--surface-2)',
            cursor: 'grab',
            touchAction: 'none', // we handle pan/zoom ourselves
            userSelect: 'none',
          }}
        >
          {img && (
            <img
              src={img.src}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: img.naturalWidth * scale,
                height: img.naturalHeight * scale,
                transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
                maxWidth: 'none',
                pointerEvents: 'none',
              }}
            />
          )}

          {/* Circular mask: dims everything outside the crop circle. */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              background: 'rgba(0,0,0,.55)',
              WebkitMaskImage:
                'radial-gradient(circle at 50% 50%, transparent 0 49.5%, #000 50%)',
              maskImage: 'radial-gradient(circle at 50% 50%, transparent 0 49.5%, #000 50%)',
            }}
          />
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              borderRadius: '50%',
              boxShadow: '0 0 0 2px var(--red)',
            }}
          />
        </div>

        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <button
            type="button"
            aria-label="Zoom out"
            className="btn btn-ghost btn-sm"
            onClick={() => applyZoom(zoom - 0.25)}
            disabled={!img || zoom <= MIN_ZOOM}
          >
            <ZoomOut size={14} />
          </button>
          <input
            type="range"
            aria-label="Zoom"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => applyZoom(Number(e.target.value))}
            disabled={!img}
            style={{ flex: 1, accentColor: 'var(--red)' }}
          />
          <button
            type="button"
            aria-label="Zoom in"
            className="btn btn-ghost btn-sm"
            onClick={() => applyZoom(zoom + 0.25)}
            disabled={!img || zoom >= MAX_ZOOM}
          >
            <ZoomIn size={14} />
          </button>
        </div>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!img || busy}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? 'Saving…' : 'Save photo'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
