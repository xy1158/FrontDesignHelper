'use strict';
// 读取 DSH 的工作区与对话列表。
// 存储格式：~/.dsh/sessions/<转义后的工作区路径>/session-<uuid>/session.v3.jsonl.zstd
// 该文件是「多帧 zstd 拼接」，单次 zstdDecompressSync 只能解出第一帧，需要按 magic 切帧。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_DECODED = 16 * 1024 * 1024;
const CACHE_TTL = 20000;

const cache = new Map(); // file -> { mtimeMs, size, data }

function dshRoot() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  return home;
}

function sessionsRoot() {
  const root = process.env.DSH_SESSIONS_DIR;
  if (root) return root;
  return path.join(dshRoot(), 'sessions');
}

function decodeZstdFrames(buf) {
  const parts = [];
  let total = 0;
  let idx = 0;
  while (idx < buf.length && total < MAX_DECODED) {
    const start = buf.indexOf(MAGIC, idx);
    if (start < 0) break;
    let next = buf.indexOf(MAGIC, start + 4);
    if (next < 0) next = buf.length;
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(start, next));
      parts.push(out);
      total += out.length;
    } catch (e) { /* 单帧损坏就跳过 */ }
    idx = next;
  }
  return Buffer.concat(parts).toString('utf8');
}

function readSessionFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  let data = null;
  try {
    const buf = fs.readFileSync(file);
    const text = decodeZstdFrames(buf);
    const info = { cwd: '', title: '', userTexts: [], assistantTexts: [], toolNames: [], eventCount: 0 };
    for (const line of text.split('\n')) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      info.eventCount++;
      if (ev.type === 'session' && ev.cwd) info.cwd = ev.cwd;
      else if (ev.type === 'session/title' && ev.data && ev.data.title) info.title = String(ev.data.title);
      else if (ev.type === 'user/message' && ev.data && Array.isArray(ev.data.content)) {
        const kind = ev.data.source && ev.data.source.kind;
        if (kind === 'user') {
          const t = ev.data.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
          if (t) info.userTexts.push(t);
        }
      } else if (ev.type === 'assistant/message' && ev.data && ev.data.message && Array.isArray(ev.data.message.content)) {
        const t = ev.data.message.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
        if (t) info.assistantTexts.push(t);
      } else if (ev.type === 'tool/call' && ev.data && ev.data.name) {
        info.toolNames.push(String(ev.data.name));
      }
    }
    data = info;
  } catch (e) {
    data = { cwd: '', title: '', userTexts: [], assistantTexts: [], toolNames: [], eventCount: 0, error: e.message };
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data: data });
  if (cache.size > 400) cache.clear();
  return data;
}

function sessionDirs(workspaceDir) {
  let names = [];
  try { names = fs.readdirSync(workspaceDir); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    const full = path.join(workspaceDir, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isDirectory() || name.indexOf('session-') !== 0) continue;
    const file = path.join(full, 'session.v3.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    out.push({ id: name, dir: full, file: file, updatedAt: st.mtimeMs });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// 工作区列表（轻量：每个工作区只解最新一条会话来拿真实 cwd）
function listWorkspaces() {
  const root = sessionsRoot();
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    let st;
    try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const sessions = sessionDirs(dir);
    if (!sessions.length) continue;
    const info = readSessionFile(sessions[0].file);
    const cwd = (info && info.cwd) || '';
    // 无法解出 cwd 时（权限/损坏），退化为转义名，至少可见可点
    const decoded = cwd || name.replace(/^--/, '').replace(/--$/, '').replace(/-/g, '\\');
    out.push({
      key: name,
      path: decoded,
      name: path.basename(decoded) || decoded,
      sessionCount: sessions.length,
      lastAt: sessions[0].updatedAt
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return out;
}

function findWorkspaceDir(workspacePath) {
  const root = sessionsRoot();
  const want = path.resolve(workspacePath || '').toLowerCase();
  const list = listWorkspaces();
  for (const w of list) {
    if (path.resolve(w.path).toLowerCase() === want) return w.key;
  }
  return null;
}

function listConversations(workspacePath) {
  const key = findWorkspaceDir(workspacePath);
  if (!key) return [];
  const dirs = sessionDirs(path.join(sessionsRoot(), key));
  const out = [];
  for (const d of dirs) {
    const info = readSessionFile(d.file);
    const title = (info && info.title) || (info && info.userTexts[0] ? String(info.userTexts[0]).slice(0, 40) : '');
    out.push({
      id: d.id,
      title: title || '(无标题)',
      updatedAt: d.updatedAt,
      messages: info ? (info.userTexts.length + info.assistantTexts.length) : 0
    });
    if (out.length >= 40) break;
  }
  return out;
}

// 把某条对话的最近内容整理成上下文块，供新任务继承
function conversationContext(workspacePath, sessionId, opts) {
  const limit = (opts && opts.limit) || 8;
  const maxChars = (opts && opts.maxChars) || 3500;
  const key = findWorkspaceDir(workspacePath);
  if (!key) return '';
  const dirs = sessionDirs(path.join(sessionsRoot(), key));
  const hit = dirs.find((d) => d.id === sessionId);
  if (!hit) return '';
  const info = readSessionFile(hit.file);
  if (!info) return '';
  const turns = [];
  const users = info.userTexts.slice(-limit);
  const asss = info.assistantTexts.slice(-limit);
  const tools = info.toolNames.slice(-12);
  turns.push('【上一条对话的标题】' + (info.title || '(无)'));
  if (users.length) turns.push('【用户最近说过】\n- ' + users.join('\n- '));
  if (asss.length) turns.push('【你（AI）最近的回复摘要】\n- ' + asss.map((t) => t.slice(0, 300)).join('\n- '));
  if (tools.length) turns.push('【用过的主要工具】' + Array.from(new Set(tools)).join(', '));
  let text = turns.join('\n\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
  return text;
}

// 投递验证：在最近若干秒内被修改的会话里，找「用户消息包含这段文字」的那条。
// 用于确认「消息真的进了某条 DSH 对话」，而不是仅凭投递 API 返回 200。
function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function findSessionByPrompt(text, opts) {
  const o = opts || {};
  const withinMs = o.withinMs || 180000;
  const probe = normalizeText(text).slice(0, o.probeChars || 28);
  if (!probe) return null;
  const now = Date.now();
  const root = sessionsRoot();
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return null; }

  let newest = null;
  for (const wsName of names) {
    const wsDir = path.join(root, wsName);
    let st;
    try { st = fs.statSync(wsDir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    for (const d of sessionDirs(wsDir)) {
      if (now - d.updatedAt > withinMs) continue;
      const info = readSessionFile(d.file);
      if (!info) continue;
      const hit = info.userTexts.some(function (u) { return normalizeText(u).indexOf(probe) >= 0; });
      const rec = {
        sessionId: d.id,
        workspaceKey: wsName,
        cwd: info.cwd || '',
        title: info.title || '',
        updatedAt: d.updatedAt,
        matched: hit
      };
      if (hit) return rec;
      if (!newest || rec.updatedAt > newest.updatedAt) newest = rec;
    }
  }
  return newest && newest.matched ? newest : null;
}

module.exports = { dshRoot, sessionsRoot, listWorkspaces, listConversations, conversationContext, decodeZstdFrames, readSessionFile, findSessionByPrompt };