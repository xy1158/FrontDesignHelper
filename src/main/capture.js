'use strict';
// 截屏：窗口枚举 / 置前 / 抓取。两条抓取链路互为兜底。
//   1) desktopCapturer window source（能直接拿到窗口自身画面，含被部分遮挡的情况）
//   2) 置前后抓屏幕并裁剪到窗口矩形（WGC 拿不到内容时的兜底）
const { desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./paths');

const HELPER = path.join(__dirname, 'win-helper.ps1');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function helperTmpFile() {
  const dir = path.join(P.dataDir(), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'helper-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.json');
}

// 用文件回传结果：不依赖 stdio 管道（受限环境下管道会失败）。
function runHelper(args, timeoutMs) {
  const limit = timeoutMs || 20000;
  return new Promise((resolve, reject) => {
    const outFile = helperTmpFile();
    const all = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER]
      .concat(args).concat(['-OutFile', outFile]);
    let child;
    try {
      child = spawn('powershell.exe', all, { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      reject(new Error('无法启动 powershell: ' + e.message));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) { /* ignore */ }
      reject(new Error('窗口助手超时（' + limit + 'ms）'));
    }, limit);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let raw = '';
      try {
        raw = fs.readFileSync(outFile, 'utf8');
      } catch (e) {
        reject(new Error('窗口助手没有输出结果文件'));
        return;
      }
      try { fs.unlinkSync(outFile); } catch (e) { /* ignore */ }
      raw = raw.replace(/^\uFEFF/, '').trim();
      if (!raw) { reject(new Error('窗口助手输出为空')); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('窗口助手输出不是合法 JSON: ' + e.message)); }
    };
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('exit', finish);
    child.on('close', finish);
  });
}

function normalizeWindowList(data) {
  if (!data || !data.ok) throw new Error('窗口枚举失败: ' + ((data && data.error) || '未知错误'));
  let wins = data.windows;
  if (!wins) wins = [];
  if (!Array.isArray(wins)) wins = [wins];
  const selfPid = process.pid;
  return wins
    .filter((w) => w && typeof w.title === 'string' && w.title.trim().length > 0)
    .filter((w) => w.pid !== selfPid)
    .filter((w) => !/FrontDesignHelper/i.test(w.title))
    .map((w) => ({
      hwnd: String(w.handle || ('0x' + Number(w.hwnd).toString(16))),
      title: w.title,
      process: w.process || '',
      pid: w.pid,
      rect: { x: w.x, y: w.y, w: w.w, h: w.h },
      iconic: !!w.iconic,
      foreground: !!w.foreground,
      monitor: w.monitor || ''
    }))
    .sort((a, b) => {
      if (a.foreground !== b.foreground) return a.foreground ? -1 : 1;
      if (a.iconic !== b.iconic) return a.iconic ? 1 : -1;
      return String(a.process).localeCompare(String(b.process)) || String(a.title).localeCompare(String(b.title));
    });
}

async function listWindows() {
  return normalizeWindowList(await runHelper(['-Action', 'list'], 25000));
}

async function describeWindow(hwnd) {
  const data = await runHelper(['-Action', 'rect', '-Hwnd', String(hwnd)], 15000);
  if (!data || !data.ok || !data.window) throw new Error('读取窗口位置失败: ' + ((data && data.error) || '未知错误'));
  const w = data.window;
  return {
    hwnd: String(w.handle || hwnd),
    title: w.title || '',
    process: w.process || '',
    pid: w.pid,
    rect: { x: w.x, y: w.y, w: w.w, h: w.h },
    iconic: !!w.iconic,
    foreground: !!w.foreground,
    monitor: w.monitor || ''
  };
}

// 把剪贴板内容粘到目标窗口并回车（仅用于用户明确要求的「投递到 DSH 对话」）。
async function pasteInto(hwnd) {
  const data = await runHelper(['-Action', 'paste', '-Hwnd', String(hwnd)], 20000);
  return !!(data && data.ok);
}

// 一次连续完成：置前 → 点进输入框 → Ctrl+V → 回车（避免分步之间的焦点竞态）。
async function deliverInto(hwnd, opts) {
  const o = opts || {};
  const args = ['-Action', 'deliver', '-Hwnd', String(hwnd)];
  if (o.clickOffsetFromBottom) args.push('-ClickOffset', String(o.clickOffsetFromBottom));
  if (o.clickXPercent) args.push('-ClickXPercent', String(o.clickXPercent));
  const data = await runHelper(args, 25000);
  return !!(data && data.ok);
}

async function focusWindow(hwnd) {
  try {
    const data = await runHelper(['-Action', 'focus', '-Hwnd', String(hwnd)], 15000);
    return !!(data && data.ok);
  } catch (e) {
    return false;
  }
}

// 临时改变 z-order（不动焦点、不发按键），用于置前被系统拒绝时把目标窗口露出来。
async function raiseWindow(hwnd, topmost) {
  try {
    const data = await runHelper(['-Action', 'raise', '-Hwnd', String(hwnd), '-Mode', topmost ? 'topmost' : 'normal'], 15000);
    return !!(data && data.ok);
  } catch (e) {
    return false;
  }
}

function displayForPhysicalRect(rect) {
  const displays = screen.getAllDisplays();
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  for (const d of displays) {
    const sf = d.scaleFactor || 1;
    const bx = d.bounds.x * sf;
    const by = d.bounds.y * sf;
    const bw = d.bounds.width * sf;
    const bh = d.bounds.height * sf;
    if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh) return d;
  }
  return screen.getPrimaryDisplay();
}

function displayInfo(d) {
  return {
    id: d.id,
    label: d.label || '',
    bounds: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
    scaleFactor: d.scaleFactor || 1
  };
}

function mostlyBlack(image) {
  try {
    const bmp = image.toBitmap();
    if (!bmp || bmp.length < 4) return true;
    const px = Math.floor(bmp.length / 4);
    const step = Math.max(1, Math.floor(px / 4000));
    let sampled = 0;
    let dark = 0;
    for (let i = 0; i < px; i += step) {
      const o = i * 4;
      if (bmp[o] < 12 && bmp[o + 1] < 12 && bmp[o + 2] < 12) dark += 1;
      sampled += 1;
    }
    return sampled > 0 && dark / sampled > 0.985;
  } catch (e) {
    return false;
  }
}

async function captureWindowSource(win) {
  const wantW = Math.min(8192, Math.max(64, win.rect.w));
  const wantH = Math.min(8192, Math.max(64, win.rect.h));
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: wantW, height: wantH },
    fetchWindowIcons: false
  });
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const target = norm(win.title);
  let hit = sources.find((s) => norm(s.name) === target);
  if (!hit) hit = sources.find((s) => norm(s.name).indexOf(target) === 0);
  if (!hit && target.length >= 8) {
    hit = sources.find((s) => norm(s.name).indexOf(target.slice(0, Math.min(24, target.length))) >= 0);
  }
  if (!hit) return null;
  const img = hit.thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  if (size.width < wantW * 0.85 || size.height < wantH * 0.85) return null;
  const wantAspect = wantW / wantH;
  const gotAspect = size.width / size.height;
  if (Math.abs(wantAspect - gotAspect) / wantAspect > 0.06) return null;
  if (mostlyBlack(img)) return null;
  return { image: img, method: 'window-source', sourceName: hit.name };
}

async function captureScreenRegion(rectPhys, display) {
  const d = display || displayForPhysicalRect(rectPhys);
  const sf = d.scaleFactor || 1;
  const thumbSize = {
    width: Math.round(d.size.width * sf),
    height: Math.round(d.size.height * sf)
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: thumbSize,
    fetchWindowIcons: false
  });
  if (!sources.length) throw new Error('没有可用的屏幕捕获源');
  let clamped = false;
  let src = sources.find((s) => String(s.display_id) === String(d.id));
  if (!src) src = sources.find((s) => s.name === d.label);
  if (!src) src = sources[0];
  const full = src.thumbnail;
  if (!full || full.isEmpty()) throw new Error('屏幕捕获返回空图');
  const fs2 = full.getSize();
  let crop;
  if (!rectPhys) {
    crop = { x: 0, y: 0, width: fs2.width, height: fs2.height };
  } else {
    const x = Math.round(rectPhys.x - d.bounds.x * sf);
    const y = Math.round(rectPhys.y - d.bounds.y * sf);
    const w = Math.round(rectPhys.w);
    const h = Math.round(rectPhys.h);
    const cx = Math.max(0, Math.min(x, fs2.width - 1));
    const cy = Math.max(0, Math.min(y, fs2.height - 1));
    const cw = Math.max(1, Math.min(w, fs2.width - cx));
    const ch = Math.max(1, Math.min(h, fs2.height - cy));
    clamped = (cx !== x || cy !== y || cw !== w || ch !== h);
    crop = { x: cx, y: cy, width: cw, height: ch };
  }
  const image = full.crop(crop);
  return {
    image,
    method: 'screen-crop',
    display: d,
    crop,
    clamped: clamped
  };
}

async function capture(opts) {
  const o = opts || {};
  const kind = o.kind === 'screen' ? 'screen' : 'window';
  if (kind === 'screen') {
    const d = screen.getPrimaryDisplay();
    const full = await captureScreenRegion(null, d);
    return {
      image: full.image,
      source: {
        kind: 'screen',
        title: '整个屏幕（' + (d.label || '主显示器') + '）',
        process: '',
        rect: { x: d.bounds.x * (d.scaleFactor || 1), y: d.bounds.y * (d.scaleFactor || 1), w: full.image.getSize().width, h: full.image.getSize().height },
        display: displayInfo(d),
        method: full.method,
        foreground: true,
        imageOrigin: { x: 0, y: 0 },
        clipped: false
      }
    };
  }

  if (!o.hwnd) throw new Error('缺少窗口句柄 hwnd');
  let win = await describeWindow(o.hwnd);
  if (!win.rect || win.rect.w < 40 || win.rect.h < 40) throw new Error('窗口尺寸异常，无法截取: ' + JSON.stringify(win.rect));

  // quiet=true：完全不打扰用户（不动焦点、不置顶、不隐藏窗口本身）。
  // 只走 desktopCapturer 的窗口直取；失败就让调用方决定是否走「打扰式」兜底。
  const quiet = !!o.quiet;
  let focused = false;
  let raised = false;
  if (!quiet) {
    focused = await focusWindow(o.hwnd);
    await sleep(360);
    if (focused) {
      try { win = await describeWindow(o.hwnd); } catch (e) { /* 沿用旧位置 */ }
    }
    // 置前失败时不再合成按键抢焦点，改为临时置顶（SWP_NOACTIVATE）截图后立刻恢复
    if (!focused) {
      raised = await raiseWindow(o.hwnd, true);
      if (raised) await sleep(320);
    }
  }

  let got = null;
  try {
    try {
      got = await captureWindowSource(win);
    } catch (e) {
      got = null;
    }
    if (!got) {
      if (quiet) {
        const err = new Error('QUIET_CAPTURE_FAILED');
        err.code = 'QUIET_CAPTURE_FAILED';
        throw err;
      }
      const d = displayForPhysicalRect(win.rect);
      const res = await captureScreenRegion(win.rect, d);
      got = { image: res.image, method: res.method, display: d, crop: res.crop, clamped: res.clamped };
    }
  } finally {
    if (raised) {
      try { await raiseWindow(o.hwnd, false); } catch (e) { /* ignore */ }
    }
  }
  const display = got.display || displayForPhysicalRect(win.rect);
  // 图片像素 (0,0) 对应窗口矩形里的哪一点；窗口直取时就是 (0,0)
  let imageOrigin = { x: 0, y: 0 };
  if (got.crop && got.display) {
    const sf = got.display.scaleFactor || 1;
    const cropPhysX = Math.round(got.display.bounds.x * sf) + got.crop.x;
    const cropPhysY = Math.round(got.display.bounds.y * sf) + got.crop.y;
    imageOrigin = { x: cropPhysX - win.rect.x, y: cropPhysY - win.rect.y };
  }
  const imgSize = got.image.getSize();
  const clipped = !!got.clamped || imgSize.width + 4 < win.rect.w || imgSize.height + 4 < win.rect.h;
  return {
    image: got.image,
    source: {
      kind: 'window',
      title: win.title,
      process: win.process,
      pid: win.pid,
      hwnd: win.hwnd,
      rect: win.rect,
      display: displayInfo(display),
      method: got.method,
      foreground: !!focused,
      raised: raised,
      imageOrigin: imageOrigin,
      clipped: clipped
    }
  };
}

module.exports = { listWindows, describeWindow, focusWindow, pasteInto, deliverInto, capture, runHelper, sleep };