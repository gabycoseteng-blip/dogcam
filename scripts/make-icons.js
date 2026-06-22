'use strict';

/**
 * Generates the app icons (home-screen / PWA) with no external dependencies.
 * Draws a simple white paw print on the app's blue accent, full-bleed so iOS
 * and Android can mask the corners themselves. Run with:  node scripts/make-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// App accent (matches the UI's #0a84ff) and the paw colour.
const BG = [10, 132, 255, 255];
const FG = [255, 255, 255, 255];

// Paw layout in unit (0..1) coordinates: one big pad + four toes.
const PAD = { x: 0.5, y: 0.64, rx: 0.2, ry: 0.17 };
const TOES = [
  { x: 0.23, y: 0.42, r: 0.082 },
  { x: 0.41, y: 0.3, r: 0.082 },
  { x: 0.59, y: 0.3, r: 0.082 },
  { x: 0.77, y: 0.42, r: 0.082 },
];

function inPaw(u, v) {
  // Big pad as an ellipse.
  const dx = (u - PAD.x) / PAD.rx;
  const dy = (v - PAD.y) / PAD.ry;
  if (dx * dx + dy * dy <= 1) return true;
  // Toes as circles.
  for (const t of TOES) {
    const tx = u - t.x;
    const ty = v - t.y;
    if (tx * tx + ty * ty <= t.r * t.r) return true;
  }
  return false;
}

function renderRGBA(size) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const c = inPaw(u, v) ? FG : BG;
      const i = (y * size + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3];
    }
  }
  return data;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  // compression, filter, interlace all 0 (already).
  // Prepend a filter byte (0 = none) to each scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [180, 192, 512]) {
  const png = encodePNG(size, renderRGBA(size));
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log('wrote', path.relative(path.join(__dirname, '..'), file), png.length, 'bytes');
}
