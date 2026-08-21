/* Генератор PNG-иконок без внешних зависимостей.
   Рисует иконку с галочкой на градиентном фоне. */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- CRC32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function drawIcon(S, maskable) {
  const rgba = Buffer.alloc(S * S * 4);
  const radius = maskable ? 0 : S * 0.22;       // maskable — полный квадрат
  const pad = maskable ? S * 0.10 : 0;          // safe-zone для maskable фон всё равно полный
  // цвета градиента
  const c1 = [0x6c, 0x8c, 0xff];
  const c2 = [0x8a, 0x6c, 0xff];
  // галочка
  const t = maskable ? 0.62 : 0.72;             // масштаб галочки в safe zone
  const off = (1 - t) / 2;
  const p1 = [S * (off + t * 0.16), S * (off + t * 0.52)];
  const p2 = [S * (off + t * 0.40), S * (off + t * 0.74)];
  const p3 = [S * (off + t * 0.82), S * (off + t * 0.28)];
  const stroke = S * 0.075;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // rounded-rect mask
      let inside = true;
      if (!maskable) {
        const rx = Math.max(radius - x, x - (S - radius), 0);
        const ry = Math.max(radius - y, y - (S - radius), 0);
        if (rx > 0 && ry > 0 && Math.hypot(rx, ry) > radius) inside = false;
      }
      if (!inside) { rgba[i + 3] = 0; continue; }
      // фон-градиент (диагональ)
      const g = (x + y) / (2 * S);
      let r = lerp(c1[0], c2[0], g);
      let gg = lerp(c1[1], c2[1], g);
      let b = lerp(c1[2], c2[2], g);
      let a = 255;
      // галочка
      const d = Math.min(
        distSeg(x, y, p1[0], p1[1], p2[0], p2[1]),
        distSeg(x, y, p2[0], p2[1], p3[0], p3[1])
      );
      if (d < stroke) {
        const edge = Math.max(0, Math.min(1, (stroke - d) / 2));
        r = lerp(r, 255, edge); gg = lerp(gg, 255, edge); b = lerp(b, 255, edge);
      }
      rgba[i] = r; rgba[i + 1] = gg; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return encodePNG(S, S, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), drawIcon(192, false));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), drawIcon(512, false));
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), drawIcon(512, true));
console.log('Иконки созданы в', outDir);
