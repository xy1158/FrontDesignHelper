'use strict';
// 会话数据层：纯 Node 实现，不依赖 Electron，便于离线验证与 MCP 直读磁盘。
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const ID_RE = /^[A-Za-z0-9._-]+$/;
const PALETTE = ['#ff5d5d', '#4f9dff', '#3ddc97', '#ffb020', '#b07bff', '#ff7ad9', '#2ee6d6', '#ffd93d'];
const MAX_ANNOTATIONS = 500;

function pad2(n) { return String(n).padStart(2, '0'); }
function nowIso() { return new Date().toISOString(); }

function newId(prefix) {
  const d = new Date();
  const stamp = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  const rnd = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 4) || 'x1';
  return prefix + stamp + '-' + rnd;
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.length > 80) {
    throw new Error('非法会话 ID: ' + String(id));
  }
  return id;
}

function dirOf(id) { return P.sessionDir(assertId(id)); }
function fileOf(id, name) { return path.join(dirOf(id), name); }

function int(v, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : dflt;
}

function normRect(r) {
  return { x: int(r && r.x, 0), y: int(r && r.y, 0), w: Math.max(1, int(r && r.w, 1)), h: Math.max(1, int(r && r.h, 1)) };
}

function normPoint(p, fallback) {
  return { x: int(p && p.x, fallback ? fallback.x : 0), y: int(p && p.y, fallback ? fallback.y : 0) };
}

// 统一清洗单条标注。existing 存在时以磁盘上的 status / aiNote / createdAt 为准。
function normalizeAnn(raw, existing) {
  const a = Object.assign({}, existing || {}, raw || {});
  const now = nowIso();
  const out = {
    id: typeof a.id === 'string' && a.id ? a.id : newId('ann-'),
    type: a.type === 'move' ? 'move' : 'box',
    color: typeof a.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(a.color) ? a.color : PALETTE[0],
    prompt: typeof a.prompt === 'string' ? a.prompt.slice(0, 4000) : '',
    status: a.status === 'done' || a.status === 'skipped' ? a.status : 'pending',
    aiNote: typeof a.aiNote === 'string' ? a.aiNote.slice(0, 2000) : '',
    createdAt: a.createdAt || now,
    updatedAt: now
  };
  if (out.type === 'move') {
    out.from = normRect(a.from || a.rect);
    out.to = normPoint(a.to, out.from);
  } else {
    out.rect = normRect(a.rect || a.from);
  }
  return out;
}

function nextColor(session) {
  const n = (session.annotations || []).length;
  return PALETTE[n % PALETTE.length];
}

function createSession(opts) {
  const o = opts || {};
  const id = newId('cap-');
  fs.mkdirSync(path.join(dirOf(id), 'crops'), { recursive: true });
  fs.writeFileSync(fileOf(id, 'base.png'), o.imageBuffer);
  const session = {
    id: id,
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: o.source || {},
    image: { file: 'base.png', width: int(o.width, 0), height: int(o.height, 0) },
    annotations: [],
    status: 'open',
    note: ''
  };
  return writeSession(session);
}

function writeSession(session) {
  session.updatedAt = nowIso();
  fs.writeFileSync(fileOf(session.id, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
  fs.writeFileSync(fileOf(session.id, 'instructions.md'), renderMarkdown(session), 'utf8');
  return session;
}

function loadSession(id) {
  const p = fileOf(id, 'session.json');
  if (!fs.existsSync(p)) throw new Error('会话不存在: ' + id);
  let s;
  try {
    s = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error('会话文件损坏: ' + id + ' (' + e.message + ')');
  }
  if (!Array.isArray(s.annotations)) s.annotations = [];
  return s;
}

function summary(s) {
  const anns = s.annotations || [];
  const counts = { box: 0, move: 0, pending: 0, done: 0, skipped: 0 };
  for (const a of anns) {
    if (a.type === 'move') { counts.move += 1; } else { counts.box += 1; }
    const st = a.status || 'pending';
    if (st === 'done') { counts.done += 1; } else if (st === 'skipped') { counts.skipped += 1; } else { counts.pending += 1; }
  }
  return {
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    status: s.status || 'open',
    source: {
      kind: (s.source && s.source.kind) || 'window',
      title: (s.source && s.source.title) || '(未命名窗口)',
      process: (s.source && s.source.process) || '',
      requestedBy: (s.source && s.source.requestedBy) || ''
    },
    width: (s.image && s.image.width) || 0,
    height: (s.image && s.image.height) || 0,
    annotationCount: anns.length,
    counts: counts,
    hasAnnotated: fs.existsSync(fileOf(s.id, 'annotated.png'))
  };
}

function listSessions() {
  const root = P.sessionsDir();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return out; }
  for (const name of names) {
    try {
      out.push(summary(loadSession(name)));
    } catch (e) { /* 跳过损坏或非会话目录 */ }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

// 编辑器整体保存：提示词/几何以传入为准，status / aiNote / createdAt 以磁盘为准。
function saveAnnotations(id, list) {
  const s = loadSession(id);
  const incoming = Array.isArray(list) ? list.slice(0, MAX_ANNOTATIONS) : [];
  const existing = new Map();
  for (const a of s.annotations) existing.set(a.id, a);
  const seen = new Set();
  const next = [];
  for (const raw of incoming) {
    const prev = raw && raw.id ? existing.get(raw.id) : null;
    const merged = normalizeAnn(raw, prev);
    if (seen.has(merged.id)) continue;
    seen.add(merged.id);
    if (prev) {
      merged.status = prev.status || 'pending';
      merged.aiNote = prev.aiNote || '';
      merged.createdAt = prev.createdAt;
    }
    next.push(merged);
  }
  s.annotations = next;
  return writeSession(s);
}

function addAnnotation(id, ann) {
  const s = loadSession(id);
  if (s.annotations.length >= MAX_ANNOTATIONS) throw new Error('标注数量已达上限 ' + MAX_ANNOTATIONS);
  const a = normalizeAnn(Object.assign({ color: nextColor(s) }, ann || {}));
  s.annotations.push(a);
  writeSession(s);
  return a;
}

function updateAnnotation(id, annId, patch) {
  const s = loadSession(id);
  const i = s.annotations.findIndex((a) => a.id === annId);
  if (i < 0) throw new Error('标注不存在: ' + annId);
  const merged = normalizeAnn(Object.assign({}, patch || {}, { id: annId }), s.annotations[i]);
  if (patch && patch.status) merged.status = patch.status;
  if (patch && typeof patch.aiNote === 'string') merged.aiNote = patch.aiNote;
  s.annotations[i] = merged;
  writeSession(s);
  return merged;
}

function deleteAnnotation(id, annId) {
  const s = loadSession(id);
  s.annotations = s.annotations.filter((a) => a.id !== annId);
  writeSession(s);
  return s;
}

function ackAnnotation(id, annId, status, note) {
  const st = status === 'skipped' ? 'skipped' : status === 'pending' ? 'pending' : 'done';
  return updateAnnotation(id, annId, { status: st, aiNote: typeof note === 'string' ? note : '' });
}

function setSessionStatus(id, status, note) {
  const s = loadSession(id);
  s.status = ['open', 'working', 'done'].indexOf(status) >= 0 ? status : 'open';
  if (typeof note === 'string') s.note = note.slice(0, 2000);
  return writeSession(s);
}

function deleteSession(id) {
  const d = dirOf(id);
  fs.rmSync(d, { recursive: true, force: true });
  return { id: id, deleted: true };
}

function imagePath(id, which) {
  const name = which === 'annotated' ? 'annotated.png' : 'base.png';
  const p = fileOf(id, name);
  return fs.existsSync(p) ? p : null;
}

function saveAnnotated(id, buffer) {
  const p = fileOf(id, 'annotated.png');
  fs.writeFileSync(p, buffer);
  return p;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return '' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function annStatusLabel(st) {
  if (st === 'done') return '已完成';
  if (st === 'skipped') return '已跳过';
  return '待处理';
}

function annTypeLabel(t) { return t === 'move' ? '挪动' : '框选'; }

function renderMarkdown(s) {
  const L = [];
  const anns = s.annotations || [];
  const c = summary(s).counts;
  const basePath = path.join(dirOf(s.id), 'base.png');
  const annPath = path.join(dirOf(s.id), 'annotated.png');
  L.push('# FrontDesignHelper · 视觉标注指令');
  L.push('');
  L.push('- 会话 ID：' + s.id);
  L.push('- 来源：' + (s.source && s.source.kind === 'screen' ? '整个屏幕' : '窗口') + '「' +
    ((s.source && s.source.title) || '未命名窗口') + '」' + ((s.source && s.source.process) ? ' · ' + s.source.process : ''));
  L.push('- 截图尺寸：' + ((s.image && s.image.width) || 0) + ' × ' + ((s.image && s.image.height) || 0) + ' 像素');
  L.push('- 捕获时间：' + fmtTime(s.createdAt));
  L.push('- 标注条目：' + anns.length + ' 条（待处理 ' + c.pending + ' / 已完成 ' + c.done + ' / 跳过 ' + c.skipped + '）');
  L.push('- 原图：' + basePath);
  L.push('- 叠加图：' + annPath);
  L.push('');
  L.push('> 坐标约定：以截图左上角为原点 (0,0)，单位为像素，x 向右、y 向下。');
  L.push('> 换算到引擎内坐标时，若坐标系原点不在窗口左上角，请整体做平移/缩放后再套用。');
  L.push('> 也可用 MCP 直接取数：get_instructions / get_capture_image / get_region_image / ack_instruction。');
  const origin = s.source && s.source.imageOrigin;
  if (origin && (origin.x !== 0 || origin.y !== 0)) {
    L.push('> 注意：本图相对窗口有偏移，图片坐标 + (' + origin.x + ',' + origin.y + ') = 窗口坐标。');
  }
  if (s.source && s.source.clipped) {
    L.push('> 注意：窗口比屏幕大，截图只覆盖屏幕内的部分。');
  }
  L.push('');
  if (!anns.length) {
    L.push('_（当前还没有任何标注。请在 FrontDesignHelper 里用「框选」或「挪动」工具圈出问题区域。）_');
    L.push('');
    return L.join('\n');
  }
  anns.forEach((a, i) => {
    L.push('## ' + (i + 1) + ' · ' + annTypeLabel(a.type) + ' · ' + annStatusLabel(a.status || 'pending'));
    if (a.type === 'move') {
      const dx = a.to.x - a.from.x;
      const dy = a.to.y - a.from.y;
      L.push('- 源区域：x=' + a.from.x + ' y=' + a.from.y + ' w=' + a.from.w + ' h=' + a.from.h);
      L.push('- 目标位置（左上角）：x=' + a.to.x + ' y=' + a.to.y);
      L.push('- 位移：dx=' + (dx >= 0 ? '+' : '') + dx + ' dy=' + (dy >= 0 ? '+' : '') + dy);
    } else {
      L.push('- 区域：x=' + a.rect.x + ' y=' + a.rect.y + ' w=' + a.rect.w + ' h=' + a.rect.h);
      L.push('- 区域中心：x=' + Math.round(a.rect.x + a.rect.w / 2) + ' y=' + Math.round(a.rect.y + a.rect.h / 2));
    }
    L.push('- 标注 ID：' + a.id);
    L.push('- 提示词：' + (a.prompt ? a.prompt.replace(/\r?\n/g, ' ') : '（用户尚未填写）'));
    if (a.aiNote) L.push('- AI 备注：' + a.aiNote);
    L.push('');
  });
  return L.join('\n');
}

module.exports = {
  PALETTE,
  newId,
  nowIso,
  createSession,
  loadSession,
  writeSession,
  listSessions,
  summary,
  saveAnnotations,
  addAnnotation,
  updateAnnotation,
  deleteAnnotation,
  ackAnnotation,
  setSessionStatus,
  deleteSession,
  imagePath,
  saveAnnotated,
  renderMarkdown,
  normalizeAnn,
  dirOf
};