// Regenerates plugin/assets/icon.png: a 256 px compass (ring, ticks, north/south needle) on a rounded tile.
//   node scripts/make_icon.mjs
// Pure Node (zlib + PNG chunks), deterministic, 4x4 supersampled.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const SIZE = 256, SS = 4;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'assets', 'icon.png');
const TILE = [24, 46, 74], RING = [236, 241, 247], NORTH = [228, 72, 60], SOUTH = [205, 214, 226], HUB = [24, 46, 74];

const c = SIZE / 2;
const inTile = (x, y) => {  // rounded square, radius 48
  const r = 48, dx = Math.max(Math.abs(x - c) - (c - r), 0), dy = Math.max(Math.abs(y - c) - (c - r), 0);
  return dx * dx + dy * dy <= r * r;
};
// Barycentric point-in-triangle.
const inTri = (px, py, [ax, ay], [bx, by], [cx, cy]) => {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d, b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return a >= 0 && b >= 0 && a + b <= 1;
};
function sample(x, y) {
  if (!inTile(x, y)) return null;
  const dx = x - c, dy = y - c, r = Math.hypot(dx, dy);
  // The needle: a north half and a south half of a slim diamond, rotated 45 degrees for a "compass" look.
  const rot = Math.PI / 4, u = dx * Math.cos(rot) + dy * Math.sin(rot), v = -dx * Math.sin(rot) + dy * Math.cos(rot);
  if (r <= 10) return HUB;
  if (r <= 14) return RING;
  if (inTri(u, v, [0, -78], [-17, 0], [17, 0])) return NORTH;
  if (inTri(u, v, [0, 78], [-17, 0], [17, 0])) return SOUTH;
  if (r >= 92 && r <= 102) return RING;  // outer ring
  // Cardinal ticks inside the ring.
  const angle = Math.atan2(dy, dx), step = Math.PI / 2, off = Math.abs(((angle % step) + step) % step - step / 2) - step / 2;
  if (r >= 80 && r < 92 && Math.abs(off * r) <= 3) return RING;
  return TILE;
}
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  let R = 0, G = 0, B = 0, A = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const color = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
    if (color) {R += color[0]; G += color[1]; B += color[2]; A++;}
  }
  const i = (y * SIZE + x) * 4;
  if (A) {rgba[i] = Math.round(R / A); rgba[i + 1] = Math.round(G / A); rgba[i + 2] = Math.round(B / A);}
  rgba[i + 3] = Math.round(255 * A / (SS * SS));
}
const crcTable = Array.from({length: 256}, (_, n) => {let k = n; for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0;});
const crc = buf => {let k = 0xffffffff; for (const b of buf) k = crcTable[(k ^ b) & 0xff] ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0;};
const chunk = (type, data) => {
  const len = Buffer.alloc(4), sum = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;  // 8-bit RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, {level: 9})), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, png);
console.log(`${OUT}: ${png.length} bytes, ${SIZE}x${SIZE}`);
