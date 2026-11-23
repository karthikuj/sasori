# OWASP Sasori brand assets

## Files
- sasori-mark.svg, sasori-mark-1024.png, sasori-mark-512.png: the mark (works on light and dark)
- apple-touch-icon-180.png
- sasori-favicon.svg, favicon.ico (16/32/48), favicon-32.png: flat small-size cut
- sasori-wordmark-universal.svg (+ -1200.png, -2400.png): one file for both GitHub themes
- sasori-wordmark-dark.svg / sasori-wordmark-light.svg (+ PNGs): for a prefers-color-scheme swap
- banner.js: CLI banner, plain and 24-bit ANSI

## README header
One file:

    <img alt="OWASP Sasori" src="brand/sasori-wordmark-universal.svg" width="480">

Theme swap:

    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="brand/sasori-wordmark-dark.svg">
      <img alt="OWASP Sasori" src="brand/sasori-wordmark-light.svg" width="480">
    </picture>

## Colors
- #9184d9  brand accent (badges, links)
- #796cbf  universal wordmark title (4.5:1 on white, 4.2:1 on #0d1117)
- #75798c  universal tagline (4.3:1 on white, 4.4:1 on #0d1117)
- #968ae0 / #b5abfc / #e7e5fe / #5d5294  tail base / highlight / glint / shadow
- #2b2741  outline and seams
- #e9e9ed  barb; wordmark on dark
- #161826  wordmark on light
- #b2b6ca / #595d6c  tagline on dark / light
