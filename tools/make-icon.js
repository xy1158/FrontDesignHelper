#!/usr/bin/env node
'use strict';
// 生成 assets/fdh.ico（256x256 PNG-in-ICO，零依赖）。
// 图形：蓝色圆角方块 + 白色选区框（四角有控制点）+ 指向右下的箭头，呼应「框选/挪动」。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets');
const OUT = path.join(OUT_DIR, 'fdh.ico');

/* ---------- 基础几何 ---------- */
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// 圆角矩形的有符号距离（负=内部）
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// 线段距离
function sdSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (x1 + vx * t);
  const dy = py - (y1 + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/* ---------- 画像素 ---------- */
const px = Buffer.alloc(SIZE * SIZE * 4);

const TOP = [0x63, 0xb0, 0xff];
const BOTTOM = [0x2a, 0x63, 0xd8];
const WHITE = [255, 255, 255];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = SIZE / 2, cy = SIZE / 2;
    const d = sdRoundRect(x + 0.5, y + 0.5, cx, cy, 118, 118, 54);
    const bgCov = clamp01(0.5 - d); // 1px 抗锯齿
    let rgb = [0, 0, 0];
    let alpha = 0;

    if (bgCov > 0) {
      const g = (y / SIZE);
      let base = mix(TOP, BOTTOM, Math.pow(g, 0.9));
      // 左上高光
      const hl = Math.max(0, 1 - Math.hypot(x - 60, y - 52) / 190) * 0.18;
      base = mix(base, WHITE, hl * bgCov);
      rgb = base;
      alpha = bgCov;
    }

    // 选区框：内缩 66，描述「框选」
    const frameD = Math.abs(sdRoundRect(x + 0.5, y + 0.5, cx, cy, 62, 62, 16)) - 4.5;
    const frameCov = clamp01(0.5 - frameD) * bgCov;
    if (frameCov > 0) { rgb = mix(rgb, WHITE, frameCov * 0.96); }

    // 四角控制点
    let handleCov = 0;
    const corners = [[cx - 62, cy - 62], [cx + 62, cy - 62], [cx - 62, cy + 62], [cx + 62, cy + 62]];
    for (const c of corners) {
      const hd = sdRoundRect(x + 0.5, y + 0.5, c[0], c[1], 9, 9, 3);
      handleCov = Math.max(handleCov, clamp01(0.5 - hd));
    }
    if (handleCov > 0) { rgb = mix(rgb, WHITE, handleCov * bgCov); }

    // 箭头（从左上到右下），表示挪动
    const arrowD = sdSegment(x + 0.5, y + 0.5, 96, 96, 160, 160) - 5;
    const arrowCov = clamp01(0.5 - arrowD) * bgCov;
    if (arrowCov > 0) { rgb = mix(rgb, WHITE, arrowCov * 0.96); }
    // 箭头头部
    const head1 = sdSegment(x + 0.5, y + 0.5, 160, 160, 160, 126) - 5;
    const head2 = sdSegment(x + 0.5, y + 0.5, 160, 160, 126, 160) - 5;
    const headCov = Math.max(clamp01(0.5 - head1), clamp01(0.5 - head2)) * bgCov;
    if (headCov > 0) { rgb = mix(rgb, WHITE, headCov * 0.96); }

    const i = (y * SIZE + x) * 4;
    px[i] = Math.round(rgb[0]);
    px[i + 1] = Math.round(rgb[1]);
    px[i + 2] = Math.round(rgb[2]);
    px[i + 3] = Math.round(clamp01(alpha) * 255);
  }
}

/* ---------- PNG 编码 ---------- */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(1, 4);   // count
  const entry = Buffer.alloc(16);
  entry[0] = 0;                 // 0 = 256
  entry[1] = 0;
  entry[2] = 0;                 // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);    // planes
  entry.writeUInt16LE(32, 6);   // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);  // offset
  return Buffer.concat([header, entry, png]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const png = encodePng(px, SIZE, SIZE);
fs.writeFileSync(path.join(OUT_DIR, 'fdh-256.png'), png);
fs.writeFileSync(OUT, encodeIco(png));
console.log('已生成: ' + OUT + ' (' + fs.statSync(OUT).size + ' B)');
console.log('同时生成: ' + path.join(OUT_DIR, 'fdh-256.png'));