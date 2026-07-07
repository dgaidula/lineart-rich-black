import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { decodePng, toCmyk, encodeTiff, convert } from '../lineart-rich-black.mjs';

const CLI = new URL('../lineart-rich-black.mjs', import.meta.url).pathname;
const run = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8' });

// ---- minimal PNG encoder (test fixtures) ------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
function makePng(width, height, channels, pixelFn) {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = pixelFn(x, y);
      for (let c = 0; c < channels; c++) raw[y * (stride + 1) + 1 + x * channels + c] = px[c];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- minimal TIFF reader (verify output) -------------------------------------

function readTiff(buf) {
  const le = buf.toString('ascii', 0, 2) === 'II';
  const u16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
  const u32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
  assert.equal(u16(2), 42, 'TIFF magic');
  let o = u32(4);
  const n = u16(o); o += 2;
  const tags = {};
  for (let i = 0; i < n; i++, o += 12) {
    const tag = u16(o), type = u16(o + 2), count = u32(o + 4);
    const value = type === 3 && count === 1 ? u16(o + 8) : u32(o + 8);
    tags[tag] = { type, count, value };
  }
  const w = tags[256].value, h = tags[257].value;
  const stripOff = tags[273].value, stripLen = tags[279].value;
  const raw = buf.subarray(stripOff, stripOff + stripLen);
  const cmyk = tags[259].value === 8 ? zlib.inflateSync(raw) : Buffer.from(raw);
  const dpi = u32(tags[282].value); // rational numerator (denominator 1)
  return { le, w, h, tags, cmyk, dpi };
}

const px = (t, x, y) => Array.from(t.cmyk.subarray((y * t.w + x) * 4, (y * t.w + x) * 4 + 4));

// ---- plate math ---------------------------------------------------------------

test('solid black maps to the full formula, white to paper', () => {
  const png = makePng(2, 1, 3, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
  const t = readTiff(convert(png, { formula: [20, 30, 20, 100] }));
  assert.deepEqual(px(t, 0, 0), [51, 77, 51, 255]); // 20%,30%,20%,100% of 255
  assert.deepEqual(px(t, 1, 0), [0, 0, 0, 0]);
});

test('mid gray scales the formula proportionally', () => {
  const png = makePng(1, 1, 3, () => [128, 128, 128]);
  const t = readTiff(convert(png, { formula: [20, 30, 20, 100] }));
  const tint = 1 - 128 / 255;
  assert.deepEqual(px(t, 0, 0), [
    Math.round(tint * 0.2 * 255), Math.round(tint * 0.3 * 255),
    Math.round(tint * 0.2 * 255), Math.round(tint * 255),
  ]);
});

test('--k-only: mids ride K alone, solids keep the full formula', () => {
  const png = makePng(2, 1, 3, (x) => (x === 0 ? [128, 128, 128] : [0, 0, 0]));
  const t = readTiff(convert(png, { formula: [20, 30, 20, 100], kOnly: true }));
  const mid = px(t, 0, 0);
  assert.deepEqual(mid.slice(0, 3), [0, 0, 0]);
  assert.ok(mid[3] > 100);
  assert.deepEqual(px(t, 1, 0), [51, 77, 51, 255]);
});

test('gates snap near-black to solid and near-white to paper', () => {
  // tints ~85% (38,38,38) and ~6% (240,240,240)
  const png = makePng(2, 1, 3, (x) => (x === 0 ? [38, 38, 38] : [240, 240, 240]));
  const t = readTiff(convert(png, { formula: [0, 0, 0, 100], gates: [80, 10] }));
  assert.equal(px(t, 0, 0)[3], 255);
  assert.equal(px(t, 1, 0)[3], 0);
});

test('--drop-paper clears light low-saturation tan, keeps art', () => {
  const png = makePng(2, 1, 3, (x) => (x === 0 ? [230, 220, 190] : [40, 40, 40]));
  const t = readTiff(convert(png, { dropPaper: [25, 25] }));
  assert.deepEqual(px(t, 0, 0), [0, 0, 0, 0]);   // tan -> paper
  assert.ok(px(t, 1, 0)[3] > 200);               // dark art untouched
});

test('alpha flattens over white', () => {
  const png = makePng(1, 1, 4, () => [0, 0, 0, 0]); // fully transparent black
  const t = readTiff(convert(png));
  assert.deepEqual(px(t, 0, 0), [0, 0, 0, 0]);
});

test('grayscale and gray+alpha PNGs decode', () => {
  for (const ch of [1, 2]) {
    const png = makePng(1, 1, ch, () => (ch === 1 ? [0] : [0, 255]));
    const t = readTiff(convert(png, { formula: [20, 30, 20, 100] }));
    assert.deepEqual(px(t, 0, 0), [51, 77, 51, 255]);
  }
});

// ---- TIFF container ------------------------------------------------------------

test('TIFF is CMYK, tagged with dpi, both byte orders parse', () => {
  const png = makePng(3, 2, 3, () => [0, 0, 0]);
  for (const littleEndian of [true, false]) {
    const t = readTiff(convert(png, { littleEndian, dpi: 600 }));
    assert.equal(t.le, littleEndian);
    assert.equal(t.tags[262].value, 5);  // Separated (CMYK)
    assert.equal(t.tags[277].value, 4);  // 4 samples
    assert.equal(t.tags[332].value, 1);  // InkSet CMYK
    assert.equal(t.dpi, 600);
    assert.equal(t.w, 3); assert.equal(t.h, 2);
    assert.equal(t.cmyk.length, 3 * 2 * 4);
  }
});

test('compression none and deflate produce identical plates', () => {
  const png = makePng(4, 4, 3, (x, y) => [(x * 60) % 256, (y * 60) % 256, 128]);
  const a = readTiff(convert(png, { compression: 'deflate' }));
  const b = readTiff(convert(png, { compression: 'none' }));
  assert.equal(a.tags[259].value, 8);
  assert.equal(b.tags[259].value, 1);
  assert.deepEqual(a.cmyk, b.cmyk);
});

test('ICC profile bytes embed under tag 34675', () => {
  const png = makePng(1, 1, 3, () => [0, 0, 0]);
  const icc = Buffer.from('FAKEICCPROFILEBYTES');
  const buf = convert(png, { icc });
  const t = readTiff(buf);
  const e = t.tags[34675];
  assert.ok(e, 'ICC tag present');
  assert.equal(e.count, icc.length);
  assert.deepEqual(buf.subarray(e.value, e.value + e.count), icc);
});

// ---- CLI ------------------------------------------------------------------------

test('CLI converts a folder, is idempotent, honors --force and --out', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lrb-'));
  try {
    writeFileSync(path.join(dir, 'a.png'), makePng(2, 2, 3, () => [0, 0, 0]));
    const out = path.join(dir, 'tifs');
    const r1 = run('--no-profile', '--out', out, dir);
    assert.match(r1, /1 converted, 0 skipped/);
    assert.ok(existsSync(path.join(out, 'a.tif')));
    const r2 = run('--no-profile', '--out', out, dir);
    assert.match(r2, /0 converted, 1 skipped/);
    const r3 = run('--no-profile', '--force', '--out', out, dir);
    assert.match(r3, /1 converted, 0 skipped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI flags: formula, gates bare and valued, byte order, bad input errors', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lrb-'));
  try {
    writeFileSync(path.join(dir, 'a.png'), makePng(1, 1, 3, () => [38, 38, 38]));
    run('--no-profile', '--gates', '--formula', '0,0,0,100', '--byte-order', 'mm', path.join(dir, 'a.png'));
    const t = readTiff(readFileSync(path.join(dir, 'a.tif')));
    assert.equal(t.le, false);
    assert.equal(px(t, 0, 0)[3], 255); // 85% tint gated to solid
    assert.throws(() => run('--no-profile', '--formula', '20,30', path.join(dir, 'a.png')));
    assert.throws(() => run('--no-profile', '--compression', 'lzw', path.join(dir, 'a.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--knockout adds unassociated alpha = ink coverage', () => {
  const png = makePng(3, 1, 3, (x) => (x === 0 ? [0, 0, 0] : x === 1 ? [255, 255, 255] : [128, 128, 128]));
  const buf = convert(png, { formula: [20, 30, 20, 100], knockout: true });
  const t = readTiff(buf);
  assert.equal(t.tags[277].value, 5);          // SamplesPerPixel
  assert.equal(t.tags[338].value, 1);          // ExtraSamples: ASSOCIATED alpha
  const ps = t.tags[34377];
  assert.ok(ps, 'Photoshop 8BIM resources present');
  assert.equal(t.tags[258].count, 5);          // 5 x 8-bit
  const px5 = (x) => Array.from(t.cmyk.subarray(x * 5, x * 5 + 5));
  assert.equal(px5(0)[4], 255);                // solid black: opaque
  assert.equal(px5(1)[4], 0);                  // paper: fully transparent
  const midAlpha = px5(2)[4];
  assert.ok(midAlpha > 100 && midAlpha < 150); // ~50% coverage
  assert.deepEqual(px5(0).slice(0, 4), [51, 77, 51, 255]); // plates unchanged
});

test('without --knockout output stays 4-sample with no ExtraSamples', () => {
  const png = makePng(1, 1, 3, () => [0, 0, 0]);
  const t = readTiff(convert(png, {}));
  assert.equal(t.tags[277].value, 4);
  assert.equal(t.tags[338], undefined);
});

test('--knockout-bg clears only border-connected background', () => {
  // 5x5: white canvas, black ring at ring distance 1, white center (enclosed)
  const png = makePng(5, 5, 3, (x, y) => {
    const edge = x === 0 || y === 0 || x === 4 || y === 4;
    const center = x === 2 && y === 2;
    return edge ? [255, 255, 255] : center ? [255, 255, 255] : [0, 0, 0];
  });
  const t = readTiff(convert(png, { knockoutBg: true }));
  assert.equal(t.tags[338].value, 1);
  const a = (x, y) => t.cmyk[(y * 5 + x) * 5 + 4];
  assert.equal(a(0, 0), 0);     // border background: transparent
  assert.equal(a(1, 1), 255);   // black ring: opaque
  assert.equal(a(2, 2), 255);   // ENCLOSED white: opaque (stays paper)
});
