# lineart-rich-black

Convert black-and-white line-art PNGs into print-ready **CMYK TIFFs**, building
the plates directly from a rich-black formula. PNG decoding via the
battle-tested [pngjs](https://github.com/pngjs/pngjs) (palette, 16-bit, and
interlaced PNGs all work); the CMYK TIFF encoder is purpose-built because no
Node library offers byte-order, InkSet, and ICC-assign control.

Generic ICC conversion lets the profile's black-generation curve decide your
plates. For line art you usually want the opposite: **exact, chosen ink
values**. This tool computes them per pixel:

```
tint = 1 − luma/255                    (0 = paper, 1 = solid black)
C = tint·c   M = tint·m   Y = tint·y   K = tint·k    ← your formula
```

Solid blacks print as your rich black, anti-aliased edges become proportional
tints (smooth edges on press), and paper stays a true 0/0/0/0.

## Install

```sh
npm install -g lineart-rich-black     # or: npx lineart-rich-black art.png
```

Node 20+. One small pure-JS dependency (pngjs) — no native modules, no ImageMagick, no Photoshop.

## Quick start

```sh
# one file -> art.tif alongside it (20/30/20/100 rich black, 600dpi, GRACoL tagged)
lineart-rich-black art.png

# a folder of pngs -> print-tifs/, with your own formula
lineart-rich-black --formula 20,30,20,100 --out print-tifs/ pngs/
```

## Options

| flag | default | meaning |
|---|---|---|
| `--formula C,M,Y,K` | `20,30,20,100` | plate percentages for solid black (TAC 170) |
| `--k-only` | off | grays/edges ride the K plate alone (scaled by the formula's K); solids keep the full formula — avoids registration fringe on fine hatching |
| `--gates [B,W]` | off (`80,10` when given) | snap tints ≥B% to solid and ≤W% to paper before building plates — cleans vectorizer/upscaler output that has near-blacks and near-whites instead of pure ones |
| `--drop-paper [T,S]` | off (`25,25` when given) | force light, low-saturation pixels (tint ≤T%, saturation ≤S%) to paper — removes tan/cream "old photo" backgrounds |
| `--dpi N` | `600` | resolution tag (600dpi ⇒ a 4096px image places at ~6.8") |
| `--profile <path\|name>` | auto | ICC profile to **assign** (embed, not convert). Auto searches Adobe/ColorSync folders for GRACoL → SWOP → Generic CMYK |
| `--no-profile` | — | write an untagged TIFF (your numbers hit the RIP verbatim) |
| `--byte-order ii\|mm` | `ii` | TIFF byte order: `ii` little-endian ("IBM PC"), `mm` big-endian ("Mac") |
| `--compression deflate\|none` | `deflate` | Deflate is ZIP (TIFF tag 8) — **not LZW** — smaller than LZW for line art and read by every modern app and RIP |
| `--out <dir>` | alongside input | output directory |
| `--force` | off | overwrite existing `.tif` (default: skip — idempotent batch re-runs) |

## Why `--gates` matters for AI-vectorizer output

Upscalers and vectorizers emit near-blacks (`rgb(13,13,14)`) and near-whites
instead of pure ones. Without gates those become **ghost tints across your
paper** (a faint warm veil over the whole sheet) and not-quite-solid blacks.
On a real test image, gating flipped 45% of pixels from ghost-tint to true
paper and 48% from near-black to true solid, leaving genuine mid-grays
untouched. If your PNGs came out of an AI pipeline, run with `--gates`.

## Rich black & fine lines

A high-TAC rich black on thin strokes risks registration fringe (C/M/Y peeking
out from under fine hatching). Mitigations, in order: use a lower-TAC formula
(the default 20/30/20/100 = TAC 170 is chosen for line art), or `--k-only` so
only large solids carry the support colors. Ask your printer about their
fine-line guidance if unsure.

## ICC tagging

The profile is **assigned, not converted** — pixel values are your formula's
numbers; the tag just tells layout apps how to preview them. Profiles are
discovered from `/Library/Application Support/Adobe/Color/Profiles` and the
ColorSync folders (Adobe's profiles can't be bundled with this tool for
licensing reasons). `--profile <file.icc>` works anywhere.

## Library use

```js
import { decodePng, toCmyk, encodeTiff, convert, findProfile } from 'lineart-rich-black';
const tiff = convert(pngBuffer, { formula: [20, 30, 20, 100], gates: [80, 10], dpi: 600 });
```

`decodePng` normalizes any PNG to 8-bit RGBA (via pngjs); `encodeTiff` is a
dependency-free CMYK TIFF writer — both usable on their own.

## Companions

Part of a small suite for AI-assisted line-art production:
[svg-color-rinse](https://github.com/dgaidula/svg-color-rinse) (normalize SVG
colors), [svg-silver-age-bg](https://github.com/dgaidula/svg-silver-age-bg)
(deterministic comic backgrounds),
[gemini-vectorize](https://github.com/dgaidula/gemini-vectorize)
(photo → redraw → vector pipeline).

## Development

```sh
npm test    # node --test: plate math, TIFF container (both byte orders), CLI
```

## License

MIT
