# Brand source

`sfu-mark-64.png` is the source every app icon in `apps/*/public` is rendered
from, via `scripts/make-icons.py`.

**It is 64x64, and that is the only reason the 512px icon looks soft.** No
larger copy was available when the icons were generated. If a higher-resolution
PNG or a vector version of the mark turns up, drop it in here and re-run:

```
python3 scripts/make-icons.py assets/brand/sfu-mark-64.png   # or the new file
```

That regenerates all four files for both apps. Nothing else needs to change:
the manifests and layouts reference the icons by name, and the names do not
change.

The field colour used for padding, `#E11D3B`, is sampled from this file rather
than taken from a brand guide, so it stays consistent with whatever source is
in use.
