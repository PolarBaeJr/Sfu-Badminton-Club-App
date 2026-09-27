# assets

Icons, splash screens and fonts for both platforms.

Do not hand draw these. `scripts/make-icons.py` already renders every app icon in
`apps/*/public` from the source mark in `assets/brand`, and it is tracked precisely
because a generator that owns committed files has to ship with them. Extend that
script to emit the iOS and Android icon sets rather than adding a second source of
truth for the brand.

The Android launcher icon (`android/app/src/main/res/drawable/ic_launcher_*.xml`
and `mipmap-anydpi`) is the exception, chosen by the owner: a vector
transcription of the site header's mark (`apps/player/src/components/shuttle-mark.tsx`)
on the header's striped red tile, not the `assets/brand` mark. `make-icons.py`
still owns the web favicons.

The app's fonts are described in `fonts/README.md`.
