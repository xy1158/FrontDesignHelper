'use strict';
// 所有业务操作的唯一实现：IPC（界面）与 HTTP（MCP）共用同一套入口。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { nativeImage } = require('electron');
const store = require('./store');
const capture = require('./capture');
const agent = require('./agent');
const dsh = require('./dsh');
const dshApi = require('./dshApi');
const P = require('./paths');

const APP_NAME = 'FrontDesignHelper';
const VERSION = '1.0.0';

const events = new EventEmitter();
events.setMaxListeners(50);

let selfCaptureFn = null;
function setSelfCapture(fn) { selfCaptureFn = fn; }

let winGuard = null;
let pickDirFn = null;
let clipboardFn = null;
function setClipboard(fn) { clipboardFn = fn; }
function setPickDirectory(fn) { pickDirFn = fn; }
function setWindowGuard(g) { winGuard = g; }

let debugUiFn = null;
function setDebugUi(fn) { debugUiFn = fn; }

function mimeOf(p) { return /\.jpg$/i.test(p) ? 'image/jpeg' : 'image/png'; }

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('不是合法的 dataURL');
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'binary');
  return { mime: m[1] || 'image/png', buffer: buf };
}

async function listWindows() {
  const wins = await capture.listWindows();
  return { windows: wins, count: wins.length };
}

async function captureTarget(args) {
  const a = args || {};
  const kind = a.kind === 'screen' ? 'screen' : 'window';
  // 第一步：静默截取（不切换焦点、不隐藏本窗口、不置顶），AI 请求截图时默认走这条，
  // 用户不会看到软件「闪一下」。窗口直取失败时才考虑打扰式兜底。
  let got = null;
  let quietFailed = false;
  if (kind === 'window') {
    try {
      got = await capture.capture({ kind: kind, hwnd: a.hwnd, quiet: true });
    } catch (e) {
      quietFailed = true;
      got = null;
    }
  }

  if (kind === 'window' && !got) {
    if (a.requestedBy === 'ai') {
      throw new Error('无法在不打扰你的情况下截取该窗口（窗口直取失败）。请在应用里手动点「截取窗口」再截一次。');
    }
    // 用户主动截取：允许隐藏本窗口 + 置前 + 屏幕裁剪兜底
    let concealed = false;
    if (winGuard) {
      try { await winGuard.conceal(); concealed = true; } catch (e) { concealed = false; }
    }
    try {
      got = await capture.capture({ kind: kind, hwnd: a.hwnd });
    } finally {
      if (concealed) {
        try { await winGuard.restore(); } catch (e) { /* ignore */ }
      }
    }
  }

  if (!got && kind !== 'window') {
    got = await capture.capture({ kind: kind, hwnd: a.hwnd });
  }
  const png = got.image.toPNG();
  const size = got.image.getSize();
  const source = Object.assign({}, got.source, {
    label: typeof a.label === 'string' ? a.label : '',
    requestedBy: a.requestedBy === 'ai' ? 'ai' : '',
    capturedAt: store.nowIso()
  });
  const session = store.createSession({
    imageBuffer: png,
    width: size.width,
    height: size.height,
    source: source
  });
  events.emit('session-created', { id: session.id, requestedBy: source.requestedBy || '', title: source.title || '', width: size.width, height: size.height });
  const warnings = [];
  if (kind === 'window' && !source.foreground) {
    warnings.push(source.raised
      ? '目标窗口未能切到前台，已临时置顶后截图（未改变你的焦点）'
      : '目标窗口未能置前，截图可能包含其它窗口遮挡；建议先手动点一下目标窗口再截');
  }
  if (source.clipped) warnings.push('窗口超出屏幕可视范围，截图只包含屏幕内的部分（AI 侧需按图片原点偏移换算）');
  return {
    id: session.id,
    session: store.summary(session),
    source: source,
    warning: warnings.join('；'),
    warnings: warnings
  };
}

function assertSessionId(id) { return store.loadSession(id); }

function getSession(args) {
  const id = String((args || {}).id || '');
  const s = store.loadSession(id);
  const annotated = store.imagePath(id, 'annotated');
  return {
    id: s.id,
    session: store.summary(s),
    annotations: s.annotations,
    markdown: store.renderMarkdown(s),
    status: s.status || 'open',
    note: s.note || '',
    source: s.source || {},
    width: (s.image && s.image.width) || 0,
    height: (s.image && s.image.height) || 0,
    hasAnnotated: !!annotated,
    basePath: store.imagePath(id, 'base'),
    annotatedPath: annotated
  };
}

function getLatestSession() {
  const list = store.listSessions();
  if (!list.length) return null;
  return getSession({ id: list[0].id });
}

function imageDataUrl(args) {
  const a = args || {};
  const which = a.which === 'annotated' ? 'annotated' : 'base';
  const p = store.imagePath(String(a.id || ''), which);
  if (!p) return { dataUrl: null, path: null, which: which };
  const buf = fs.readFileSync(p);
  return { dataUrl: 'data:' + mimeOf(p) + ';base64,' + buf.toString('base64'), path: p, which: which, bytes: buf.length };
}

function saveAnnotations(args) {
  const a = args || {};
  const s = store.saveAnnotations(String(a.id || ''), a.annotations);
  return { session: store.summary(s), annotations: s.annotations };
}

function addAnnotation(args) {
  const a = args || {};
  const ann = store.addAnnotation(String(a.id || ''), a.annotation || {});
  const s = store.loadSession(String(a.id));
  return { annotation: ann, session: store.summary(s), annotations: s.annotations };
}

function updateAnnotation(args) {
  const a = args || {};
  const ann = store.updateAnnotation(String(a.id || ''), String(a.annId || ''), a.patch || {});
  const s = store.loadSession(String(a.id));
  return { annotation: ann, session: store.summary(s), annotations: s.annotations };
}

function deleteAnnotation(args) {
  const a = args || {};
  const s = store.deleteAnnotation(String(a.id || ''), String(a.annId || ''));
  return { session: store.summary(s), annotations: s.annotations };
}

function ackAnnotation(args) {
  const a = args || {};
  const ann = store.ackAnnotation(String(a.id || ''), String(a.annId || ''), a.status, a.note);
  return { annotation: ann };
}

function setSessionStatus(args) {
  const a = args || {};
  const s = store.setSessionStatus(String(a.id || ''), a.status, a.note);
  return { session: store.summary(s) };
}

function deleteSession(args) {
  return store.deleteSession(String((args || {}).id || ''));
}

function saveAnnotated(args) {
  const a = args || {};
  const parsed = parseDataUrl(a.dataUrl);
  const p = store.saveAnnotated(String(a.id || ''), parsed.buffer);
  return { ok: true, path: p, bytes: parsed.buffer.length };
}

// 取某个标注（或任意矩形）对应的局部截图，供 AI 精确查看。
function regionCrop(args) {
  const a = args || {};
  const id = String(a.id || '');
  const s = assertSessionId(id);
  const basePath = store.imagePath(id, 'base');
  if (!basePath) throw new Error('会话没有原图: ' + id);
  const img = nativeImage.createFromPath(basePath);
  const size = img.getSize();
  let rect = null;
  let annId = null;
  if (a.annId) {
    annId = String(a.annId);
    const ann = (s.annotations || []).find((x) => x.id === annId);
    if (!ann) throw new Error('标注不存在: ' + annId);
    rect = ann.type === 'move' ? ann.from : ann.rect;
  } else if (a.rect) {
    rect = a.rect;
  } else {
    rect = { x: 0, y: 0, w: size.width, h: size.height };
  }
  const pad = Math.max(0, Math.min(400, Math.round(Number(a.pad) || 0)));
  let x = Math.round(Number(rect.x) || 0) - pad;
  let y = Math.round(Number(rect.y) || 0) - pad;
  let w = Math.round(Number(rect.w) || 0) + pad * 2;
  let h = Math.round(Number(rect.h) || 0) + pad * 2;
  x = Math.max(0, Math.min(x, size.width - 1));
  y = Math.max(0, Math.min(y, size.height - 1));
  w = Math.max(1, Math.min(w, size.width - x));
  h = Math.max(1, Math.min(h, size.height - y));
  const cropped = img.crop({ x: x, y: y, width: w, height: h });
  const buffer = cropped.toPNG();
  return {
    buffer: buffer,
    mime: 'image/png',
    rect: { x: x, y: y, w: w, h: h },
    annId: annId,
    bytes: buffer.length,
    imageWidth: size.width,
    imageHeight: size.height
  };
}

// 自检钩子：在渲染进程里重放受控的 UI 动作（工具切换 / 拖拽 / 输入提示词 / 单击），
// 只接受固定动作类型，不接受任意代码。返回界面快照用于断言。
async function debugUi(args) {
  if (!debugUiFn) throw new Error('UI 自检钩子不可用');
  const actions = Array.isArray(args && args.actions) ? args.actions : [];
  return await debugUiFn(actions);
}

// 一键让 AI 修改：在后台启动 headless DSH 任务（同一时刻只允许一个）
// DSH 官方接口状态（端口 + 会话列表，用于界面显示与探测）
async function dshStatus() {
  try {
    const p = await dshApi.ping();
    return {
      ok: true,
      port: p.port,
      sessions: p.sessions.map(function (s) {
        return { sessionId: s.sessionId, running: !!s.running, updatedAt: s.updatedAt, blank: !!s.blank };
      })
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 把任务投进指定 DSH 对话并让它立刻开始（走官方 RPC，不模拟按键、不需要窗口在前台）。
// sessionId 为空表示在该工作区新建一条对话。
async function sendToDshConversation(args) {
  const a = args || {};
  const prompt = String(a.prompt || '').trim();
  if (!prompt) throw new Error('指令不能为空');
  const workspace = a.workspace ? path.resolve(String(a.workspace)) : P.ROOT;
  if (!fs.existsSync(workspace)) throw new Error('工作区不存在: ' + workspace);

  if (a.sessionId) {
    const r = await dshApi.promptSession(String(a.sessionId), prompt);
    return { ok: true, via: 'api', created: false, sessionId: r.sessionId, port: r.port, accepted: r.accepted };
  }
  const created = await dshApi.createSession(workspace);
  const r = await dshApi.promptSession(created.sessionId, prompt, created.port);
  return { ok: true, via: 'api', created: true, sessionId: created.sessionId, port: created.port, accepted: r.accepted };
}

// 把任务投递到用户正在使用的 DSH 对话窗口：复制 → 切前台 → Ctrl+V → 回车。
// 只按窗口标题匹配（绝不按进程名批量命中），且只在用户明确点「开始」时执行。
async function deliverToDsh(args) {
  const a = args || {};
  const prompt = String(a.prompt || '').trim();
  if (!prompt) throw new Error('指令不能为空');
  const needle = String(a.windowTitle || 'DeepSeek Harness').trim();
  if (!needle) throw new Error('请填写 DSH 窗口标题关键字');

  const wins = await capture.listWindows();
  const needleLower = needle.toLowerCase();
  const candidates = wins.filter(function (w) {
    return String(w.title || '').toLowerCase().indexOf(needleLower) >= 0;
  });
  if (!candidates.length) {
    const names = wins.slice(0, 12).map(function (w) { return '· ' + w.title; }).join('\n');
    throw new Error('没找到标题包含「' + needle + '」的窗口。当前可用窗口：\n' + (names || '(无)'));
  }
  // 优先已在前台的那个，否则取面积最大的
  candidates.sort(function (a1, b1) {
    if (a1.foreground !== b1.foreground) return a1.foreground ? -1 : 1;
    return (b1.rect.w * b1.rect.h) - (a1.rect.w * a1.rect.h);
  });
  const target = candidates[0];

  if (clipboardFn) { try { await clipboardFn(prompt); } catch (e) { /* 剪贴板失败不致命 */ } }

  if (!a.autoPaste) {
    return { ok: true, pasted: false, windowTitle: target.title, hwnd: target.hwnd, candidates: candidates.length };
  }

  // 本应用现在在前台，会挡住前台切换；先最小化自己让出前台
  let steppedAside = false;
  if (winGuard) {
    try { await winGuard.minimize(); steppedAside = true; } catch (e) { /* ignore */ }
  }
  await new Promise(function (r) { setTimeout(r, 420); });

  // 一次连续动作：置前 → 点进输入框 → Ctrl+V → 回车（避免分步焦点竞态）
  let pasted = false;
  for (let attempt = 0; attempt < 3 && !pasted; attempt++) {
    try {
      pasted = await capture.pasteInto(target.hwnd);
    } catch (e) { pasted = false; }
    if (!pasted) await new Promise(function (r) { setTimeout(r, 420); });
  }

  // 关键一步：去 DSH 的会话文件里核对「这段文字真的进了某条对话」
  let verified = null;
  if (pasted) {
    for (let i = 0; i < 24 && !verified; i++) {
      try { verified = dsh.findSessionByPrompt(prompt, { withinMs: 240000 }); } catch (e) { verified = null; }
      if (!verified) await new Promise(function (r) { setTimeout(r, 500); });
    }
  }

  if (!pasted) {
    if (steppedAside && winGuard) { try { await winGuard.show(); } catch (e) { /* ignore */ } }
    return {
      ok: false,
      pasted: false,
      verified: false,
      windowTitle: target.title,
      hwnd: target.hwnd,
      candidates: candidates.length,
      error: '已复制到剪贴板，但没能把内容送进 DSH（可能是窗口前台切换被系统拒绝）。请切到 DSH 输入框按 Ctrl+V 再回车；或改用「官方接口」方式。'
    };
  }

  return {
    ok: true,
    pasted: true,
    verified: !!verified,
    sessionId: verified ? verified.sessionId : '',
    sessionTitle: verified ? (verified.title || '') : '',
    workspaceKey: verified ? verified.workspaceKey : '',
    windowTitle: target.title,
    hwnd: target.hwnd,
    candidates: candidates.length,
    steppedAside: steppedAside,
    warning: verified ? '' : '已粘贴并回车，但 12 秒内没在 DSH 会话里找到这条消息。可能光标不在输入框内，请手动确认。'
  };
}

// 浏览器标题里带着当前对话名（形如「<对话标题> — DeepSeek Harness - Edge」）。
// 用它来猜「用户此刻在看哪条对话」，好把任务投到看得见的地方。
function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/[\s·。，,.、:：()（）\[\]【】]/g, '');
}

async function detectOpenSession(workspace, conversations) {
  if (!conversations.length) return '';
  let wins = [];
  try { wins = await capture.listWindows(); } catch (e) { return ''; }
  const dshWins = wins.filter(function (w) { return /deepseek\s*harness/i.test(String(w.title || '')); });
  for (const w of dshWins) {
    const head = String(w.title).split(/\s+[\u2014\u2013-]\s+/)[0];
    const target = normalizeTitle(head);
    if (target.length < 4) continue;
    let best = null;
    let bestScore = 0;
    for (const c of conversations) {
      const t = normalizeTitle(c.title);
      if (!t) continue;
      let score = 0;
      const n = Math.min(t.length, target.length);
      while (score < n && t.charCodeAt(score) === target.charCodeAt(score)) score++;
      // 允许标题被截断：只要重合长度够长就算命中
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best) {
      const need = Math.max(4, Math.min(12, Math.floor(normalizeTitle(best.title).length * 0.4)));
      if (bestScore >= need) return best.id;
    }
  }
  return '';
}

// 工作区 / 对话枚举（供「让 AI 开始修改」弹窗选择）
async function getAgentTargets(args) {
  const a = args || {};
  const workspaces = dsh.listWorkspaces();
  const conversations = a.workspace ? dsh.listConversations(a.workspace) : [];
  const openSessionId = await detectOpenSession(a.workspace, conversations);
  return {
    workspaces: workspaces,
    conversations: conversations,
    openSessionId: openSessionId,
    workspace: a.workspace || '',
    nodeAvailable: !!agent.findNode(),
    dshAvailable: !!agent.findDsh()
  };
}

// 打开 DSH 的 Web 界面（帮助用户投递后立刻看到对话）
async function openDshUi() {
  const p = await dshApi.ping();
  return { url: 'http://127.0.0.1:' + p.port + '/', port: p.port };
}

async function pickDirectory() {
  if (!pickDirFn) throw new Error('目录选择器不可用');
  return await pickDirFn();
}

async function startAgentRun(args) {
  const a = args || {};
  const started = agent.start({ sessionId: a.sessionId, prompt: a.prompt, workspace: a.workspace, continueFrom: a.continueFrom });
  return { ok: true, run: agent.status().run, pid: started.pid, logPath: started.logPath };
}

function getAgentRun() {
  const st = agent.status();
  const out = { run: st.run };
  if (st.run && !st.run.running) out.logTail = agent.tailLog(st.run.logPath, 12);
  return out;
}

function cancelAgentRun() {
  return agent.cancel();
}

// 自截：把应用自己的界面存成 PNG，便于自动化验收与截图留证。
async function debugCaptureSelf() {
  if (!selfCaptureFn) throw new Error('自截功能不可用');
  const buf = await selfCaptureFn();
  const dir = path.join(P.dataDir(), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'self-' + Date.now() + '.png');
  fs.writeFileSync(p, buf);
  return { path: p, bytes: buf.length };
}

// 给 AI 的结构化指令包（含人读的 markdown 与图片绝对路径）
function getInstructions(args) {
  const a = args || {};
  let id = a.id ? String(a.id) : '';
  if (!id || id === 'latest') {
    const list = store.listSessions();
    if (!list.length) throw new Error('还没有任何截图会话，先在 FrontDesignHelper 里截取一个窗口');
    id = list[0].id;
  }
  const s = store.loadSession(id);
  const basePath = store.imagePath(id, 'base');
  const annotatedPath = store.imagePath(id, 'annotated');
  const instructions = (s.annotations || []).map((ann, i) => {
    const base = {
      index: i + 1,
      id: ann.id,
      type: ann.type,
      status: ann.status || 'pending',
      color: ann.color,
      prompt: ann.prompt || '',
      aiNote: ann.aiNote || ''
    };
    if (ann.type === 'move') {
      base.from = ann.from;
      base.to = ann.to;
      base.dx = ann.to.x - ann.from.x;
      base.dy = ann.to.y - ann.from.y;
      base.sourceCenter = { x: Math.round(ann.from.x + ann.from.w / 2), y: Math.round(ann.from.y + ann.from.h / 2) };
    } else {
      base.rect = ann.rect;
      base.center = { x: Math.round(ann.rect.x + ann.rect.w / 2), y: Math.round(ann.rect.y + ann.rect.h / 2) };
    }
    return base;
  });
  return {
    id: id,
    summary: store.summary(s),
    source: s.source || {},
    image: {
      width: (s.image && s.image.width) || 0,
      height: (s.image && s.image.height) || 0,
      basePath: basePath,
      annotatedPath: annotatedPath,
      imageOrigin: (s.source && s.source.imageOrigin) || { x: 0, y: 0 },
      clipped: !!(s.source && s.source.clipped)
    },
    coordinateConvention: 'origin=(0,0) 为截图左上角，单位像素，x 向右 y 向下；请换算到目标引擎坐标系后再落地。' +
      ((s.source && s.source.imageOrigin && (s.source.imageOrigin.x || s.source.imageOrigin.y))
        ? '注意：本图相对窗口有偏移，图片坐标 + (' + s.source.imageOrigin.x + ',' + s.source.imageOrigin.y + ') = 窗口坐标。'
        : ''),
    instructions: instructions,
    markdown: store.renderMarkdown(s)
  };
}

function runtimeInfo() {
  return {
    name: APP_NAME,
    version: VERSION,
    pid: process.pid,
    dataDir: P.dataDir(),
    sessionsDir: P.sessionsDir(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node
  };
}

const OPS = {
  health: () => ({ ok: true, name: APP_NAME, version: VERSION }),
  runtimeInfo: runtimeInfo,
  listWindows: listWindows,
  captureTarget: captureTarget,
  listSessions: () => ({ sessions: store.listSessions() }),
  getSession: getSession,
  getLatestSession: getLatestSession,
  getInstructions: getInstructions,
  imageDataUrl: imageDataUrl,
  saveAnnotations: saveAnnotations,
  addAnnotation: addAnnotation,
  updateAnnotation: updateAnnotation,
  deleteAnnotation: deleteAnnotation,
  ackAnnotation: ackAnnotation,
  setSessionStatus: setSessionStatus,
  deleteSession: deleteSession,
  saveAnnotated: saveAnnotated,
  regionCrop: regionCrop,
  debugCaptureSelf: debugCaptureSelf,
  debugUi: debugUi,
  startAgentRun: startAgentRun,
  getAgentRun: getAgentRun,
  getAgentTargets: getAgentTargets,
  deliverToDsh: deliverToDsh,
  dshStatus: dshStatus,
  openDshUi: openDshUi,
  sendToDshConversation: sendToDshConversation,
  pickDirectory: pickDirectory,
  cancelAgentRun: cancelAgentRun
};

async function dispatch(op, args) {
  const fn = OPS[op];
  if (!fn) throw new Error('未知操作: ' + String(op));
  const result = await fn(args || {});
  return result;
}

module.exports = { dispatch, OPS, VERSION, APP_NAME, regionCrop, getInstructions, setSelfCapture, setDebugUi, setWindowGuard, setPickDirectory, setClipboard, events };