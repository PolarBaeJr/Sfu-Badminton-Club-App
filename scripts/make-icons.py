#!/usr/bin/env python3
"""Render the app icon set for both apps from a single source image.

    python3 scripts/make-icons.py <source-image>

WHY THIS EXISTS. The icons currently in the repo were generated from a 64x64
PNG, because that was the only copy of the mark available. A 64px source cannot
produce a sharp 512px icon, and the committed icon-512.png is visibly soft as a
result. When a proper high-resolution or vector asset turns up, re-run this
against it and the softness goes away with no other changes.

WHAT WAS TRIED AND REJECTED. Supersampling the two-tone mask and thresholding
it back to hard edges gives crisp outlines but wrecks the artwork: the shield
contour goes lumpy and the wordmark's counters close up, because "SFU" is only
about 12px tall in a 64px source. A faithful Lanczos resample with a gentle
unsharp pass looks softer but stays true to the mark, which is the better
trade for somebody else's logo. Do not reintroduce the threshold.
"""
import os
import sys
from PIL import Image, ImageFilter

# Sampled from the source mark rather than typed in from a brand guide.
FIELD = (225, 29, 59)

# 512 is declared "any maskable" in both manifests. Android crops a maskable
# icon to a circle and only guarantees the centre 80%, and the wordmark reaches
# roughly 86% of the frame, so it is inset to clear the mask. The padding is the
# same solid red as the field, so the seam is invisible.
MASKABLE_INSET = 0.10

TARGETS = [
    ('apple-touch-icon.png', 180, 0.0),
    ('icon-192.png', 192, 0.0),
    ('icon-512.png', 512, MASKABLE_INSET),
]
APPS = ('player', 'admin')


def render(src: Image.Image, size: int, inset: float) -> Image.Image:
    art = int(round(size * (1 - 2 * inset)))
    up = src.resize((art, art), Image.LANCZOS)
    up = up.filter(ImageFilter.UnsharpMask(radius=max(0.5, art / 128), percent=110, threshold=2))
    canvas = Image.new('RGB', (size, size), FIELD)
    offset = (size - art) // 2
    canvas.paste(up, (offset, offset))
    # Near-two-tone artwork, so a palette costs nothing visible and roughly
    # thirds the file. Dithering is off: it would add noise the mark does not have.
    return canvas.quantize(colors=64, method=Image.MEDIANCUT, dither=Image.NONE)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src = Image.open(sys.argv[1]).convert('RGB')
    if min(src.size) < 512:
        print(f'note: source is {src.size[0]}x{src.size[1]}; 512+ gives a sharp icon-512', file=sys.stderr)

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for app in APPS:
        public = os.path.join(root, 'apps', app, 'public')
        for name, size, inset in TARGETS:
            render(src, size, inset).save(os.path.join(public, name), optimize=True)
        # Rendered per size rather than downsampled from one image, so 16px
        # keeps what edge definition it can.
        icons = [render(src, s, 0.0).convert('RGB') for s in (16, 32, 48)]
        icons[2].save(
            os.path.join(public, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)]
        )
        print(f'wrote {len(TARGETS) + 1} files to apps/{app}/public')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
