#!/usr/bin/env node
// lineart-rich-black — convert B/W line-art PNGs to print-ready CMYK TIFFs,
// building the plates directly from a rich-black formula.
// Decoding via pngjs; the CMYK TIFF encoder is purpose-built (no Node library
// offers byte-order, InkSet, and ICC-assign control).
//
// Generic ICC conversion lets the profile's black generation decide your
// plates. For line art you usually want the opposite: exact, chosen plate
// values. This tool computes them per pixel from the grayscale value:
//
//   tint = 1 - luma/255          (0 = paper, 1 = solid black)
//   C = tint*c  M = tint*m  Y = tint*y  K = tint*k     <- your formula
//
// so solid blacks print as your rich black, anti-aliased edges become
// proportional tints, and paper stays 0/0/0/0.
//
// Usage:
//   lineart-rich-black art.png                     # writes art.tif alongside
//   lineart-rich-black --out print-tifs/ pngs/     # batch a folder
//
// Options:
//   --formula C,M,Y,K   plate percentages for solid black (default 20,30,20,100)
//   --k-only            grays/edges ride the K plate alone (scaled by the
//                       formula's K); solid blacks still get the full formula
//   --knockout          add an unassociated alpha channel (ExtraSamples 2)
//                       where alpha = ink coverage: paper is fully
//                       transparent, solids opaque, anti-aliased edges
//                       partial. Plates are unchanged, so the image still
//                       looks correct in apps that ignore alpha.
//   --knockout-bg       like --knockout but only BORDER-CONNECTED background
//                       clears: enclosed paper inside the artwork (a polaroid
//                       frame, white costume, speech balloon) stays opaque
//                       white. Use when white is part of the subject.
//   --gates [B,W]       svg-color-rinse-style snap: tints >=B% become solid,
//                       <=W% become paper (default 80,10 when flag given)
//   --drop-paper [T,S]  force light, low-saturation pixels (tint <= T%,
//                       saturation <= S%) to paper white — cleans tan/cream
//                       "old photo" backgrounds (default 25,25 when given)
//   --dpi N             resolution tag (default 600)
//   --profile <p>       ICC profile to EMBED (assign, not convert): a .icc
//                       path or a name searched in the system/Adobe profile
//                       folders. Default: auto (GRACoL -> SWOP -> Generic CMYK)
//   --no-profile        write an untagged TIFF
//   --byte-order ii|mm  TIFF byte order: ii = little-endian ("IBM PC",
//                       default), mm = big-endian ("Mac")
//   --compression X     deflate (ZIP, default) or none. Note: Deflate is NOT
//                       LZW — it is the PNG/zlib codec (TIFF tag 8), smaller
//                       than LZW for line art and read by all modern apps.
//   --out <dir>         output directory (default: alongside each input)
//   --force             overwrite existing .tif outputs (default: skip)
//
// Also importable as a library:
//   import { decodePng, encodeTiff, convert } from 'lineart-rich-black';

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// ---- PNG decoding (pngjs: handles palette, 16-bit, interlaced, all types) ---

import { PNG } from 'pngjs';

/**
 * Decode any PNG via pngjs, normalized to 8-bit RGBA.
 * Returns { width, height, channels: 4, pixels } with pixels as a flat Buffer.
 */
export function decodePng(buf) {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, channels: 4, pixels: png.data };
}

// ---- CMYK plate math --------------------------------------------------------

/**
 * Convert decoded PNG pixels to a CMYK buffer (4 bytes/pixel) using a
 * rich-black formula. Alpha is flattened over white.
 */
export function toCmyk(img, opts = {}) {
  const {
    formula = [20, 30, 20, 100],
    kOnly = false,
    gates = null,          // [blackPct, whitePct] or null
    dropPaper = null,      // [maxTintPct, maxSatPct] or null
    knockout = false,      // add unassociated alpha = ink coverage
    knockoutBg = false,    // alpha clears only border-connected background
  } = opts;
  const [fc, fm, fy, fk] = formula.map((v) => v / 100);
  const { width, height, channels, pixels } = img;
  const anyAlpha = knockout || knockoutBg;
  const spp = anyAlpha ? 5 : 4;
  const out = Buffer.alloc(width * height * spp);
  const solidAt = gates ? gates[0] / 100 : 0.99;
  const tints = knockoutBg ? new Float32Array(width * height) : null;

  for (let p = 0, o = 0; p < width * height; p++, o += spp) {
    const i = p * channels;
    let r, g, b, a = 255;
    if (channels === 1) { r = g = b = pixels[i]; }
    else if (channels === 2) { r = g = b = pixels[i]; a = pixels[i + 1]; }
    else if (channels === 3) { r = pixels[i]; g = pixels[i + 1]; b = pixels[i + 2]; }
    else { r = pixels[i]; g = pixels[i + 1]; b = pixels[i + 2]; a = pixels[i + 3]; }
    if (a < 255) { // flatten over white paper
      r = Math.round(r * a / 255 + 255 * (1 - a / 255));
      g = Math.round(g * a / 255 + 255 * (1 - a / 255));
      b = Math.round(b * a / 255 + 255 * (1 - a / 255));
    }

    let tint = 1 - (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    if (dropPaper) {
      const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      if (tint <= dropPaper[0] / 100 && sat <= dropPaper[1] / 100) tint = 0;
    }
    if (gates) {
      if (tint >= gates[0] / 100) tint = 1;
      else if (tint <= gates[1] / 100) tint = 0;
    }

    if (kOnly && tint < solidAt) {
      out[o + 3] = Math.round(tint * fk * 255);
    } else {
      out[o] = Math.round(tint * fc * 255);
      out[o + 1] = Math.round(tint * fm * 255);
      out[o + 2] = Math.round(tint * fy * 255);
      out[o + 3] = Math.round(tint * fk * 255);
    }
    if (anyAlpha) out[o + 4] = Math.round(tint * 255); // alpha = ink coverage
    if (tints) tints[p] = tint;
  }
  if (knockoutBg) {
    // flood from the borders through light pixels (tint < 0.5): that region
    // keeps coverage alpha (background fades out through AA edges); everything
    // else — art AND enclosed paper like a polaroid frame — becomes opaque.
    const mask = new Uint8Array(width * height);
    const q = [];
    const seed = (p) => { if (!mask[p] && tints[p] < 0.5) { mask[p] = 1; q.push(p); } };
    for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
    while (q.length) {
      const p = q.pop(); const x = p % width;
      if (x > 0) seed(p - 1);
      if (x < width - 1) seed(p + 1);
      if (p >= width) seed(p - width);
      if (p < width * (height - 1)) seed(p + width);
    }
    for (let p = 0; p < width * height; p++) {
      if (!mask[p]) out[p * 5 + 4] = 255; // interior: fully opaque (incl. paper)
    }
  }
  return out;
}

// ---- TIFF encoding ----------------------------------------------------------

const T = { SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7 };

/**
 * Encode a CMYK buffer as a single-strip baseline TIFF.
 * opts: { dpi=600, littleEndian=true, compression='deflate'|'none', icc=Buffer|null }
 */
export function encodeTiff(cmyk, width, height, opts = {}) {
  const { dpi = 600, littleEndian = true, compression = 'deflate', icc = null, knockout = false, knockoutBg = false } = opts;
  const spp = (knockout || knockoutBg) ? 5 : 4;
  const strip = compression === 'deflate' ? zlib.deflateSync(cmyk, { level: 9 }) : cmyk;
  const compTag = compression === 'deflate' ? 8 : 1;

  const pad = (n) => n + (n % 2); // TIFF values must start on even offsets
  const stripOff = 8;
  const iccOff = pad(stripOff + strip.length);
  const bitsOff = pad(iccOff + (icc ? icc.length : 0));
  const xResOff = bitsOff + spp * 2;     // spp x SHORT
  const yResOff = xResOff + 8;           // RATIONAL
  const ifdOff = yResOff + 8;

  const entries = [
    [256, T.LONG, 1, width],
    [257, T.LONG, 1, height],
    [258, T.SHORT, spp, bitsOff],        // 8 per sample (out of line)
    [259, T.SHORT, 1, compTag],
    [262, T.SHORT, 1, 5],                // PhotometricInterpretation: Separated (CMYK)
    [273, T.LONG, 1, stripOff],
    [277, T.SHORT, 1, spp],              // SamplesPerPixel
    [278, T.LONG, 1, height],            // RowsPerStrip: single strip
    [279, T.LONG, 1, strip.length],
    [282, T.RATIONAL, 1, xResOff],
    [283, T.RATIONAL, 1, yResOff],
    [296, T.SHORT, 1, 2],                // ResolutionUnit: inch
    [332, T.SHORT, 1, 1],                // InkSet: CMYK
  ];
  if (knockout || knockoutBg) entries.push([338, T.SHORT, 1, 2]); // ExtraSamples: unassociated alpha
  if (icc) entries.push([34675, T.UNDEFINED, icc.length, iccOff]);
  entries.sort((a, b) => a[0] - b[0]);

  const total = ifdOff + 2 + entries.length * 12 + 4;
  const buf = Buffer.alloc(total);
  const w16 = (v, o) => littleEndian ? buf.writeUInt16LE(v, o) : buf.writeUInt16BE(v, o);
  const w32 = (v, o) => littleEndian ? buf.writeUInt32LE(v, o) : buf.writeUInt32BE(v, o);

  buf.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
  w16(42, 2);
  w32(ifdOff, 4);
  strip.copy(buf, stripOff);
  if (icc) icc.copy(buf, iccOff);
  for (let i = 0; i < spp; i++) w16(8, bitsOff + i * 2);
  w32(dpi, xResOff); w32(1, xResOff + 4);
  w32(dpi, yResOff); w32(1, yResOff + 4);

  let o = ifdOff;
  w16(entries.length, o); o += 2;
  for (const [tag, type, count, value] of entries) {
    w16(tag, o); w16(type, o + 2); w32(count, o + 4);
    // value is left-justified in the 4-byte field: SHORT occupies the first
    // two bytes of the field in either byte order
    if (type === T.SHORT && count === 1) { w16(value, o + 8); w16(0, o + 10); }
    else w32(value, o + 8);
    o += 12;
  }
  w32(0, o); // no next IFD
  return buf;
}

// ---- ICC profile discovery --------------------------------------------------

const PROFILE_DIRS = [
  '/Library/Application Support/Adobe/Color/Profiles',
  path.join(process.env.HOME ?? '', 'Library/ColorSync/Profiles'),
  '/Library/ColorSync/Profiles',
  '/System/Library/ColorSync/Profiles',
];

function listProfiles(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) listProfiles(p, out);
    else if (/\.icc?$/i.test(n)) out.push(p);
  }
  return out;
}

export function findProfile(nameOrPath) {
  if (nameOrPath && existsSync(nameOrPath) && statSync(nameOrPath).isFile()) {
    return { path: nameOrPath, data: readFileSync(nameOrPath) };
  }
  const all = PROFILE_DIRS.flatMap((d) => listProfiles(d));
  const wanted = nameOrPath ? [nameOrPath] : ['GRACoL', 'SWOP', 'Generic CMYK'];
  for (const want of wanted) {
    const hit = all.find((p) => path.basename(p).toLowerCase().includes(want.toLowerCase()));
    if (hit) return { path: hit, data: readFileSync(hit) };
  }
  return null;
}

// ---- high-level convert -----------------------------------------------------

export function convert(pngBuffer, opts = {}) {
  const img = decodePng(pngBuffer);
  const cmyk = toCmyk(img, opts);
  return encodeTiff(cmyk, img.width, img.height, opts);
}

// ---- CLI ---------------------------------------------------------------------

function optionalValue(argv, flag, defaults, parse) {
  // supports "--flag" (use defaults) and "--flag a,b" (parse values)
  const i = argv.indexOf(flag);
  if (i === -1) return { value: null, consumed: [] };
  const next = argv[i + 1];
  if (next && !next.startsWith('--') && /^[\d.,]+$/.test(next)) {
    return { value: parse(next), consumed: [next] };
  }
  return { value: defaults, consumed: [] };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n');
    const header = [];
    for (const l of lines.slice(1)) {
      if (!l.startsWith('//')) break;
      header.push(l.slice(3));
    }
    console.log(header.join('\n'));
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const nums = (s) => s.split(',').map(Number);
  const gatesOpt = optionalValue(argv, '--gates', [80, 10], nums);
  const paperOpt = optionalValue(argv, '--drop-paper', [25, 25], nums);
  const consumedValues = new Set([...gatesOpt.consumed, ...paperOpt.consumed]);

  const getValue = (flag, dflt) => {
    const i = argv.indexOf(flag);
    if (i === -1) return dflt;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { console.error(`${flag} needs a value`); process.exit(1); }
    consumedValues.add(v);
    return v;
  };

  const opts = {
    formula: nums(getValue('--formula', '20,30,20,100')),
    kOnly: argv.includes('--k-only'),
    knockout: argv.includes('--knockout') && !argv.includes('--knockout-bg'),
    knockoutBg: argv.includes('--knockout-bg'),
    gates: gatesOpt.value,
    dropPaper: paperOpt.value,
    dpi: Number(getValue('--dpi', '600')),
    littleEndian: getValue('--byte-order', 'ii').toLowerCase() !== 'mm',
    compression: getValue('--compression', 'deflate'),
  };
  if (opts.formula.length !== 4 || opts.formula.some((v) => Number.isNaN(v) || v < 0 || v > 100)) {
    console.error('--formula needs four percentages, e.g. 20,30,20,100'); process.exit(1);
  }
  if (!['deflate', 'none'].includes(opts.compression)) {
    console.error('--compression must be "deflate" or "none" (Deflate is ZIP/tag 8, not LZW)'); process.exit(1);
  }
  const outDir = argv.includes('--out') ? getValue('--out', null) : null;
  const force = argv.includes('--force');

  let icc = null;
  if (!argv.includes('--no-profile')) {
    const want = argv.includes('--profile') ? getValue('--profile', null) : null;
    const found = findProfile(want);
    if (found) { icc = found.data; console.log(`ICC: assigning ${path.basename(found.path)}`); }
    else if (want) { console.error(`profile "${want}" not found (searched Adobe/ColorSync folders)`); process.exit(1); }
    else console.log('ICC: no CMYK profile found — writing untagged (use --profile <path>)');
  }
  opts.icc = icc;

  const files = [];
  const collect = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const e of readdirSync(p).sort()) collect(path.join(p, e));
    else if (/\.png$/i.test(p)) files.push(p);
  };
  for (const a of argv) {
    if (a.startsWith('--') || consumedValues.has(a)) continue;
    if (!existsSync(a)) { console.error(`not found: ${a}`); process.exit(1); }
    collect(a);
  }
  if (files.length === 0) { console.error('no PNG inputs found'); process.exit(1); }
  if (outDir) mkdirSync(outDir, { recursive: true });

  let done = 0, skipped = 0;
  for (const f of files) {
    const dest = path.join(outDir ?? path.dirname(f), path.basename(f).replace(/\.png$/i, '.tif'));
    if (!force && existsSync(dest)) { skipped++; continue; }
    const tiff = convert(readFileSync(f), opts);
    writeFileSync(dest, tiff);
    console.log(`${path.basename(f)} -> ${dest} (${(tiff.length / 1024 / 1024).toFixed(1)} MB)`);
    done++;
  }
  console.log(`${done} converted, ${skipped} skipped (existing)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
