/*
 * Recueil — fixtures
 * Copyright (C) 2026 the Recueil authors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * An 8-bit greyscale canvas, the bitmap font drawn onto it, and a PNG encoder.
 *
 * This exists so the scan fixtures can be *pictures of text* rather than text. A page whose words
 * are pixels is the only honest way to fixture the OCR stage: an importer cannot accidentally read
 * it, a `pdftotext` over it returns nothing, and a deskew step has something genuinely crooked to
 * straighten.
 *
 * Everything here is deterministic. The speckle is a seeded xorshift, never `Math.random()`, so
 * regenerating the corpus does not move a single hash.
 */
import zlib from 'node:zlib';

import { GLYPH_HEIGHT, GLYPH_WIDTH, glyph } from './font-5x7.mjs';

/** Paper is not white on a scan, and ink is not black. */
export const PAPER = 0xf2;
export const INK = 0x1c;

/**
 * @typedef {object} Canvas
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} pixels  one byte per pixel, row-major, 0 = black
 */

/**
 * @param {number} width
 * @param {number} height
 * @param {number} [fill]
 * @returns {Canvas}
 */
export function canvas(width, height, fill = PAPER) {
  return { width, height, pixels: new Uint8Array(width * height).fill(fill) };
}

/** @param {Canvas} c */
function put(c, x, y, value) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= c.width || py >= c.height) return;
  const at = py * c.width + px;
  // Ink is darkening, not replacement: overlapping strokes stay dark and a stroke over a speckle
  // does not brighten it.
  if (value < c.pixels[at]) c.pixels[at] = value;
}

/**
 * Draw a line of text.
 *
 * @param {Canvas} c
 * @param {object} spec
 * @param {string} spec.text
 * @param {number} spec.x        left edge, device pixels
 * @param {number} spec.y        top edge, device pixels
 * @param {number} [spec.scale]  device pixels per font pixel
 * @param {number} [spec.ink]
 * @param {number} [spec.tracking]  extra device pixels between glyph cells
 * @param {{ angle: number, ox: number, oy: number }} [spec.rotate]
 *        radians, about (`ox`, `oy`) in device pixels. This is how the skewed page is skewed: the
 *        pixels themselves are crooked, not the placement of a straight image on the page.
 * @returns {number} the x coordinate one cell past the last glyph
 */
export function drawText(c, { text, x, y, scale = 3, ink = INK, tracking = 0, rotate }) {
  const cos = rotate ? Math.cos(rotate.angle) : 1;
  const sin = rotate ? Math.sin(rotate.angle) : 0;
  const place = (px, py) => {
    if (!rotate) return put(c, px, py, ink);
    const dx = px - rotate.ox;
    const dy = py - rotate.oy;
    return put(c, rotate.ox + dx * cos - dy * sin, rotate.oy + dx * sin + dy * cos, ink);
  };

  let penX = x;
  for (const char of text) {
    const mask = glyph(char);
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      for (let col = 0; col < GLYPH_WIDTH; col += 1) {
        if (!mask[row][col]) continue;
        // Fill the cell sub-pixel by sub-pixel: rotating the four corners of a block would leave
        // gaps along the diagonal, and a scan with gaps in its strokes is a scan of nothing.
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            place(penX + col * scale + sx, y + row * scale + sy);
          }
        }
      }
    }
    penX += (GLYPH_WIDTH + 1) * scale + tracking;
  }
  return penX;
}

/**
 * Draw a filled rectangle — rules, table borders, the black edge a flatbed leaves.
 *
 * @param {Canvas} c
 */
export function fillRect(c, { x, y, width, height, ink = INK, rotate }) {
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      if (!rotate) {
        put(c, x + dx, y + dy, ink);
        continue;
      }
      const rx = x + dx - rotate.ox;
      const ry = y + dy - rotate.oy;
      const cos = Math.cos(rotate.angle);
      const sin = Math.sin(rotate.angle);
      put(c, rotate.ox + rx * cos - ry * sin, rotate.oy + rx * sin + ry * cos, ink);
    }
  }
}

/**
 * Scatter dust and paper grain over the page, deterministically.
 *
 * @param {Canvas} c
 * @param {object} spec
 * @param {number} spec.seed
 * @param {number} [spec.density]  fraction of pixels touched
 */
export function speckle(c, { seed, density = 0.006 }) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  const touches = Math.floor(c.width * c.height * density);
  for (let i = 0; i < touches; i += 1) {
    const at = Math.floor(next() * c.pixels.length);
    const shade = next();
    // Mostly faint grain; occasionally a real speck of dust, which is what makes an OCR engine's
    // despeckle step earn its keep.
    c.pixels[at] = shade < 0.12 ? 0x40 : Math.max(0, c.pixels[at] - Math.floor(shade * 26));
  }
}

/**
 * Turn the canvas a quarter turn clockwise.
 *
 * A sheet fed into the scanner sideways is captured sideways: the raster really is landscape, and
 * the `/Rotate` in the page dictionary is the correction. Rotating the pixels rather than only
 * setting `/Rotate` is what makes the fixture honest — ignore the page rotation and you hand the
 * text recogniser an image lying on its side, which is the failure the fixture is for.
 *
 * @param {Canvas} c
 * @returns {Canvas}
 */
export function quarterTurn(c) {
  const turned = canvas(c.height, c.width, PAPER);
  for (let y = 0; y < c.height; y += 1) {
    for (let x = 0; x < c.width; x += 1) {
      turned.pixels[x * turned.width + (c.height - 1 - y)] = c.pixels[y * c.width + x];
    }
  }
  return turned;
}

/**
 * Encode the canvas as a greyscale PNG (colour type 0, bit depth 8, one filter-0 scanline per row).
 *
 * Written out here rather than pulled from a library because the fixture corpus must be rebuildable
 * from the repository with nothing installed. `zlib.deflateSync` at a pinned level is deterministic.
 *
 * @param {Canvas} c
 * @returns {Buffer}
 */
export function encodePng(c) {
  const raw = Buffer.alloc((c.width + 1) * c.height);
  for (let y = 0; y < c.height; y += 1) {
    raw[y * (c.width + 1)] = 0; // filter: none
    Buffer.from(c.pixels.buffer, c.pixels.byteOffset + y * c.width, c.width).copy(
      raw,
      y * (c.width + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.width, 0);
  ihdr.writeUInt32BE(c.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), used by both PNG chunks and zip entries. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
