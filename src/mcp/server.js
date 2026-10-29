#!/usr/bin/env node
'use strict';
// FrontDesignHelper MCP 服务器（stdio / 零依赖）
// 主动通道：通过本地回环桥（data/runtime.json 里的 port+token）访问桌面应用内核。
// 降级通道：应用没开时，会话列表/指令/原图/叠加图/回写 仍可直接走磁盘。
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');

const P = require('../main/paths');
const store = require('../main/store');

// 数据目录定位：环境变量 > 项目 data/ > 打包版的 %APPDATA%\FrontDesignHelper\data。
// 这样无论应用以源码方式还是打包方式启动，MCP 服务都能找到它的 runtime.json 与会话文件。
function candidateDataDirs() {
  const out = [];
  if (process.env.FDH_DATA_DIR) out.push(path.resolve(process.env.FDH_DATA_DIR));
  out.push(path.join(P.ROOT, 'data'));
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'FrontDesignHelper', 'data'));
  if (process.env.XDG_CONFIG_HOME) out.push(path.join(process.env.XDG_CONFIG_HOME, 'FrontDesignHelper', 'data'));
  return out;
}

function pickDataDir() {
  const dirs = candidateDataDirs();
  for (let i = 0; i < dirs.length; i++) {
    try { if (fs.existsSync(path.join(dirs[i], 'runtime.json'))) return dirs[i]; } catch (e) { /* ignore */ }
  }
  for (let i = 0; i < dirs.length; i++) {
    try { if (fs.existsSync(path.join(dirs[i], 'sessions'))) return dirs[i]; } catch (e) { /* ignore */ }
  }
  return dirs[dirs.length - 1];
}

if (!process.env.FDH_DATA_DIR) {
  try { process.env.FDH_DATA_DIR = pickDataDir(); } catch (e) { /* 保持默认 */ }
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'front-design-helper', version: '1.0.0' };

/* ------------------------------ 桥接传输 ------------------------------ */

function readRuntime() {
  try {
    const p = P.runtimeFile();
    if (!fs.existsSync(p)) return null;
    const info = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    if (!info || !info.port || !info.token) return null;
    return info;
  } catch (e) {
    return null;
  }
}

function request(opts) {
  return new Promise(function (resolve, reject) {
    const payload = opts.body == null ? null : Buffer.from(JSON.stringify(opts.body), 'utf8');
    const headers = { 'x-fdh-token': opts.token };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const req = http.request({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path,
      method: opts.method || 'GET',
      headers: headers,
      timeout: opts.timeout || 60000
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    req.on('timeout', function () { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function rpc(op, args, timeoutMs) {
  const rt = readRuntime();
  if (!rt) throw new Error('APP_NOT_RUNNING');
  const res = await request({
    port: rt.port, token: rt.token, method: 'POST', path: '/api/rpc',
    body: { op: op, args: args || {} }, timeout: timeoutMs
  });
  let data;
  try {
    data = JSON.parse(res.body.toString('utf8'));
  } catch (e) {
    throw new Error('桥接返回无法解析（HTTP ' + res.status + '）');
  }
  if (!data || !data.ok) throw new Error((data && data.error) || ('桥接调用失败: ' + op));
  return data.result;
}

async function fetchImage(relPath, timeoutMs) {
  const rt = readRuntime();
  if (!rt) throw new Error('APP_NOT_RUNNING');
  const sep = relPath.indexOf('?') >= 0 ? '&' : '?';
  const res = await request({
    port: rt.port, token: rt.token, method: 'GET',
    path: relPath + sep + 'token=' + encodeURIComponent(rt.token),
    timeout: timeoutMs || 60000
  });
  const ctype = String(res.headers['content-type'] || '');
  if (res.status !== 200 || ctype.indexOf('image/') !== 0) {
    let msg = '取图失败（HTTP ' + res.status + '）';
    try { msg = JSON.parse(res.body.toString('utf8')).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return {
    base64: res.body.toString('base64'),
    mimeType: ctype.split(';')[0],
    bytes: res.body.length,
    headers: res.headers
  };
}

function appRunning() { return !!readRuntime(); }

/* ------------------------------ 工具定义 ------------------------------ */

const TOOLS = [
  {
    name: 'list_captures',
    description: '列出所有截图会话（最新在前）。每条包含会话 ID、来源窗口、截图尺寸、标注条数与待处理数量。先调它来找到要处理的会话。应用没运行时也能读（磁盘只读）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_instructions',
    description: '读取指定会话（默认最新）的视觉标注指令：每条标注的区域/挪动坐标、用户写的提示词、待处理状态，以及一段可直接阅读的 Markdown。用户框选或挪动区块并填写提示词后调用它。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话 ID，缺省或 latest 表示最新一条' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_capture_image',
    description: '取会话的截图。默认返回叠加图（已把框选编号、箭头、挪动后的预览位置画上去，等于用户的「意图结果图」）；which=base 取原始截图。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话 ID，缺省为最新' },
        which: { type: 'string', enum: ['annotated', 'base'], description: 'annotated=叠加意图图（默认），base=原始截图' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_region_image',
    description: '取某个标注（或任意矩形）在原图上的局部图，用来精确看清细节。给 annotation_id 时自动用该标注的区域；也可直接给 x/y/w/h。需要应用在运行。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话 ID，缺省为最新' },
        annotation_id: { type: 'string', description: '标注 ID（get_instructions 里返回）' },
        x: { type: 'number' }, y: { type: 'number' },
        w: { type: 'number' }, h: { type: 'number' },
        pad: { type: 'number', description: '向外扩展的像素数，默认 0，最大 400' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'request_capture',
    description: '让桌面应用立刻截取一个窗口（按标题/进程模糊匹配），截完会自动在界面里打开并返回新会话。用户说「看下现在的界面」时用它。需要应用在运行。',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: '窗口标题或进程名的一部分，例如 godot / unity / 主场景；留空表示整个屏幕' },
        mode: { type: 'string', enum: ['window', 'screen'], description: 'window=指定窗口（默认），screen=主显示器整屏' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'ack_instruction',
    description: '回写某条标注的处理结果，用户在界面上会立刻看到状态变绿。改完一处就调一次，别攒着。应用没运行时也能写（直接落盘）。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话 ID，缺省为最新' },
        annotation_id: { type: 'string', description: '标注 ID' },
        status: { type: 'string', enum: ['done', 'skipped', 'pending'], description: 'done=已处理，skipped=不做，pending=重置' },
        note: { type: 'string', description: '一句话说明你实际改了什么（会显示在界面上）' }
      },
      required: ['annotation_id'],
      additionalProperties: false
    }
  }
];

/* ------------------------------ 通用 ------------------------------ */

function text(t) { return { type: 'text', text: String(t) }; }
function image(b64, mime) { return { type: 'image', data: b64, mimeType: mime || 'image/png' }; }
const OFFLINE_NOTE = '\n（FrontDesignHelper 应用当前未运行，以下是磁盘只读结果；request_capture / get_region_image 需要先启动应用）';

function summarizeSession(s) {
  return [
    'ID: ' + s.id,
    '来源: ' + (s.source && s.source.kind === 'screen' ? '整屏' : '窗口') + ' 「' + ((s.source && s.source.title) || '') + '」' +
      ((s.source && s.source.process) ? ' (' + s.source.process + ')' : ''),
    '尺寸: ' + s.width + 'x' + s.height,
    '时间: ' + s.createdAt,
    '标注: ' + s.annotationCount + ' 条（待处理 ' + s.counts.pending + ' / 已完成 ' + s.counts.done + ' / 跳过 ' + s.counts.skipped + '）'
  ].join('\n');
}

function listSummaryBody(list, prefix) {
  if (!list.length) return prefix + '还没有任何截图会话。请让用户在 FrontDesignHelper 里点「截取窗口」，或让 AI 调用 request_capture。';
  const body = list.map(function (s, i) {
    return '## ' + (i + 1) + ' · ' + s.id + (i === 0 ? '  ← 最新' : '') + '\n' + summarizeSession(s);
  }).join('\n\n');
  return prefix + '共 ' + list.length + ' 个会话：\n\n' + body;
}

// 解析会话 ID：支持 latest / 缺省；离线时用磁盘列表
function resolveId(idArg) {
  const want = String(idArg || 'latest');
  if (want && want !== 'latest') return want;
  if (appRunning()) return 'latest';
  const list = store.listSessions();
  if (!list.length) throw new Error('还没有任何截图会话');
  return list[0].id;
}

function offlineInstructions(id) {
  const s = store.loadSession(id);
  const basePath = store.imagePath(id, 'base');
  const annotatedPath = store.imagePath(id, 'annotated');
  const instructions = (s.annotations || []).map(function (ann, i) {
    const base = {
      index: i + 1, id: ann.id, type: ann.type, status: ann.status || 'pending',
      color: ann.color, prompt: ann.prompt || '', aiNote: ann.aiNote || ''
    };
    if (ann.type === 'move') {
      base.from = ann.from;
      base.to = ann.to;
      base.dx = ann.to.x - ann.from.x;
      base.dy = ann.to.y - ann.from.y;
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
    image: { width: (s.image && s.image.width) || 0, height: (s.image && s.image.height) || 0, basePath: basePath, annotatedPath: annotatedPath },
    coordinateConvention: 'origin=(0,0) 为截图左上角，单位像素，x 向右 y 向下；请换算到目标引擎坐标系后再落地。',
    instructions: instructions,
    markdown: store.renderMarkdown(s)
  };
}

/* ------------------------------ 工具实现 ------------------------------ */

async function toolListCaptures() {
  let list;
  let offline = false;
  try {
    const r = await rpc('listSessions', {});
    list = r.sessions || [];
  } catch (e) {
    offline = true;
    list = store.listSessions();
  }
  return { content: [text(listSummaryBody(list, offline ? OFFLINE_NOTE + '\n\n' : ''))] };
}

async function toolGetInstructions(args) {
  const idArg = args && args.session_id ? String(args.session_id) : 'latest';
  let d;
  let offline = false;
  try {
    d = await rpc('getInstructions', { id: idArg });
  } catch (e) {
    offline = true;
    d = offlineInstructions(resolveId(idArg));
  }
  const head = '会话 ' + d.id + ' 有 ' + d.instructions.length + ' 条标注。\n' +
    '原图: ' + (d.image.basePath || '(仅内存)') + '\n' +
    '叠加图: ' + (d.image.annotatedPath || '(尚未生成，可调用 get_capture_image 触发渲染)') + '\n' +
    '坐标约定: ' + d.coordinateConvention + '\n';
  const structured = d.instructions.map(function (it) {
    return {
      index: it.index, id: it.id, type: it.type, status: it.status, prompt: it.prompt,
      rect: it.rect, from: it.from, to: it.to, dx: it.dx, dy: it.dy
    };
  });
  const content = [text((offline ? OFFLINE_NOTE + '\n\n' : '') + head + '\n--- 标注指令（Markdown） ---\n\n' + d.markdown)];
  content.push(text('--- 结构化数据 ---\n' + JSON.stringify({ session_id: d.id, image_size: d.image, annotations: structured }, null, 2)));
  if (d.instructions.length === 0) content.push(text('提示：这个会话还没有标注。让用户先在界面上框选或挪动区块并填写提示词。'));
  return { content: content };
}

async function toolGetCaptureImage(args) {
  const idArg = args && args.session_id ? String(args.session_id) : 'latest';
  const which = args && args.which === 'base' ? 'base' : 'annotated';
  let id;
  let meta = null;
  try {
    const d = await rpc('getInstructions', { id: idArg });
    id = d.id;
    meta = d.image;
  } catch (e) {
    id = resolveId(idArg);
    const s = store.loadSession(id);
    meta = { width: (s.image && s.image.width) || 0, height: (s.image && s.image.height) || 0 };
  }
  let picked = which;
  const annPath = store.imagePath(id, 'annotated');
  if (which === 'annotated' && !annPath) picked = 'base';
  let img;
  try {
    img = await fetchImage('/api/image/' + encodeURIComponent(id) + '/' + picked);
  } catch (e) {
    // 离线：直接读磁盘
    const file = store.imagePath(id, picked);
    if (!file) throw new Error('会话 ' + id + ' 没有 ' + picked + ' 图片');
    const buf = fs.readFileSync(file);
    img = { base64: buf.toString('base64'), mimeType: 'image/png', bytes: buf.length };
  }
  const notes = [
    '会话: ' + id,
    '图片: ' + (picked === 'annotated' ? '叠加意图图（框选编号 + 箭头 + 挪动预览）' : '原始截图'),
    '尺寸: ' + (meta && meta.width ? meta.width + 'x' + meta.height : '(未知)'),
    picked !== which ? '注意: 叠加图尚未生成（用户还没在界面里保存过），这里返回的是原始截图。' : ''
  ].filter(Boolean).join('\n');
  return { content: [text(notes), image(img.base64, img.mimeType)] };
}

async function toolGetRegionImage(args) {
  const a = args || {};
  const idArg = a.session_id ? String(a.session_id) : 'latest';
  let id;
  try {
    const d = await rpc('getInstructions', { id: idArg });
    id = d.id;
  } catch (e) {
    id = resolveId(idArg);
  }
  let qs = [];
  if (a.annotation_id) {
    qs.push('ann=' + encodeURIComponent(String(a.annotation_id)));
  } else if (a.x != null || a.y != null || a.w != null || a.h != null) {
    qs.push('x=' + Math.round(Number(a.x) || 0));
    qs.push('y=' + Math.round(Number(a.y) || 0));
    qs.push('w=' + Math.max(1, Math.round(Number(a.w) || 0) || 1));
    qs.push('h=' + Math.max(1, Math.round(Number(a.h) || 0) || 1));
  } else {
    throw new Error('需要 annotation_id 或 x/y/w/h');
  }
  if (a.pad) qs.push('pad=' + Math.max(0, Math.min(400, Math.round(Number(a.pad)))));
  let img;
  try {
    img = await fetchImage('/api/region/' + encodeURIComponent(id) + '?' + qs.join('&'));
  } catch (e) {
    if (e && e.message === 'APP_NOT_RUNNING') {
      throw new Error('应用未运行，无法裁切区域图。请先启动 FrontDesignHelper，或改用 get_capture_image 取整张原图。');
    }
    throw e;
  }
  const rect = String(img.headers['x-fdh-rect'] || '');
  const size = String(img.headers['x-fdh-image-size'] || '');
  return {
    content: [
      text('会话: ' + id + '\n裁剪区域(in原图坐标): ' + (rect || '(未知)') + '\n原图尺寸: ' + (size || '(未知)')),
      image(img.base64, img.mimeType)
    ]
  };
}

async function toolRequestCapture(args) {
  const a = args || {};
  if (!appRunning()) throw new Error('应用未运行，无法截图。请先启动 FrontDesignHelper 桌面应用。');
  const mode = a.mode === 'screen' ? 'screen' : 'window';
  if (mode === 'screen') {
    const r = await rpc('captureTarget', { kind: 'screen', requestedBy: 'ai' }, 120000);
    return { content: [text('已截取整个屏幕，新会话 ' + r.id + '。\n' + summarizeSession(r.session) + (r.warning ? '\n警告: ' + r.warning : ''))] };
  }
  const want = String(a.window || '').trim().toLowerCase();
  if (!want) {
    const r = await rpc('captureTarget', { kind: 'screen', requestedBy: 'ai' }, 120000);
    return { content: [text('没有指定窗口，已截取整个屏幕，新会话 ' + r.id + '。\n' + summarizeSession(r.session))] };
  }
  const wins = await rpc('listWindows', {});
  const cands = wins.windows || [];
  const hit = cands.find(function (w) { return String(w.title).toLowerCase().indexOf(want) >= 0; }) ||
    cands.find(function (w) { return String(w.process).toLowerCase().indexOf(want) >= 0; });
  if (!hit) {
    const names = cands.slice(0, 25).map(function (w) { return '- ' + w.process + ' | ' + w.title; }).join('\n');
    throw new Error('没有匹配「' + a.window + '」的窗口。当前可用窗口：\n' + (names || '(无)'));
  }
  const r = await rpc('captureTarget', { kind: 'window', hwnd: hit.hwnd, label: hit.title, requestedBy: 'ai' }, 120000);
  return {
    content: [text('已截取窗口「' + hit.title + '」，新会话 ' + r.id + '。\n' + summarizeSession(r.session) +
      (r.warning ? '\n警告: ' + r.warning : '') +
      '\n界面已自动切换到这个会话。现在让用户标注，或直接调用 get_instructions。')]
  };
}

async function toolAckInstruction(args) {
  const a = args || {};
  if (!a.annotation_id) throw new Error('缺少 annotation_id');
  const idArg = a.session_id ? String(a.session_id) : 'latest';
  let d;
  let offline = false;
  try {
    d = await rpc('getInstructions', { id: idArg });
  } catch (e) {
    offline = true;
    d = offlineInstructions(resolveId(idArg));
  }
  const found = (d.instructions || []).find(function (it) { return it.id === a.annotation_id; });
  if (!found) throw new Error('会话 ' + d.id + ' 里没有标注 ' + a.annotation_id);
  let status;
  if (offline) {
    const ann = store.ackAnnotation(d.id, a.annotation_id, a.status || 'done', a.note || '');
    status = ann.status;
  } else {
    const r = await rpc('ackAnnotation', { id: d.id, annId: a.annotation_id, status: a.status || 'done', note: a.note || '' });
    status = r.annotation.status;
  }
  return {
    content: [text('已回写：标注 ' + a.annotation_id + '（第 ' + found.index + ' 条）状态 = ' + status +
      (a.note ? '，备注：' + a.note : '') + (offline ? '（磁盘直写，应用未运行）' : '。界面会在 3 秒内显示。'))]
  };
}

const HANDLERS = {
  list_captures: toolListCaptures,
  get_instructions: toolGetInstructions,
  get_capture_image: toolGetCaptureImage,
  get_region_image: toolGetRegionImage,
  request_capture: toolRequestCapture,
  ack_instruction: toolAckInstruction
};

/* ------------------------------ JSON-RPC ------------------------------ */

function createServer(opts) {
  const write = opts.write;
  const log = opts.log || function () {};

  async function handle(msg) {
    const isNotification = msg.id === undefined || msg.id === null;
    try {
      if (msg.method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: 'FrontDesignHelper：读取用户在桌面应用里做的视觉标注（框选+提示词、区块挪动），据此修改引擎界面。先 list_captures 找会话，再 get_instructions 读指令，改完用 ack_instruction 回写。'
          }
        };
      }
      if (msg.method === 'notifications/initialized' || msg.method === 'initialized') return null;
      if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
      if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
      if (msg.method === 'tools/call') {
        const p = msg.params || {};
        const name = p.name;
        const fn = HANDLERS[name];
        if (!fn) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: '未知工具: ' + String(name) } };
        try {
          const result = await fn(p.arguments || {});
          return { jsonrpc: '2.0', id: msg.id, result: result };
        } catch (e) {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [text('调用失败：' + (e && e.message ? e.message : String(e)))], isError: true }
          };
        }
      }
      if (msg.method === 'resources/list') return { jsonrpc: '2.0', id: msg.id, result: { resources: [] } };
      if (msg.method === 'prompts/list') return { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } };
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: '未实现的方法: ' + String(msg.method) } };
    } catch (e) {
      log('handle error', e && e.message ? e.message : String(e));
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e && e.message ? e.message : String(e) } };
    }
  }

  async function onLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log('bad json', e.message);
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
      return;
    }
    const res = await handle(msg);
    if (res) write(res);
  }

  return { handle: handle, onLine: onLine, tools: TOOLS };
}

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const server = createServer({
    write: function (obj) { process.stdout.write(JSON.stringify(obj) + '\n'); },
    log: function () {
      const parts = Array.prototype.slice.call(arguments).map(String);
      process.stderr.write('[fdh-mcp] ' + parts.join(' ') + '\n');
    }
  });
  process.stdin.on('error', function () { });
  process.stdout.on('error', function () { });
  rl.on('line', function (line) {
    server.onLine(line).catch(function (e) {
      process.stderr.write('[fdh-mcp] fatal ' + (e && e.stack ? e.stack : String(e)) + '\n');
    });
  });
  rl.on('close', function () { process.exit(0); });
  process.stderr.write('[fdh-mcp] ready (stdio)\n');
}

module.exports = { createServer, TOOLS, HANDLERS, startStdio, readRuntime, rpc };

if (require.main === module) startStdio();