# assets

Icons, splash screens and fonts for both platforms.

Do not hand draw these. `scripts/make-icons.py` already renders every app icon in
`apps/*/public` from the source mark in `assets/brand`, and it is tracked precisely
because a generator that owns committed files has to ship with them. Extend that
script to emit the iOS and Android icon sets rather than adding a second source of
truth for the brand.
