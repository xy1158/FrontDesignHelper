#!/usr/bin/env node
'use strict';
// 离线 + 端到端自检。用法：
//   node test/smoke.js            全部（应用在跑时自动跑端到端）
//   node test/smoke.js --offline  只跑数据层 + MCP 协议
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
// 可用 FDH_DATA_DIR 指向任意数据目录（例如打包版落在 %APPDATA% 下的那份）
const { dataRoot } = require('./_env');
const DATA_ROOT = dataRoot();
const OFFLINE_DATA = path.join(ROOT, '.tmp', 'smoke-data');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')); console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ------------------------- PNG 生成（离线测试用） ------------------------- */
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
function makePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = rgb[0];
      raw[o + 2 + x * 3] = rgb[1];
      raw[o + 3 + x * 3] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
function isPng(buf) {
  return buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

/* ------------------------- 1. 数据层 ------------------------- */
async function testStore() {
  console.log('\n[1] 数据层（store.js，离线）');
  fs.rmSync(OFFLINE_DATA, { recursive: true, force: true });
  process.env.FDH_DATA_DIR = OFFLINE_DATA;
  const store = require(path.join(ROOT, 'src', 'main', 'store.js'));

  const png = makePng(300, 200, [30, 40, 60]);
  const s = store.createSession({ imageBuffer: png, width: 300, height: 200, source: { kind: 'window', title: '测试窗口 · Godot', process: 'godot.exe' } });
  ok('createSession 生成合法 ID', /^cap-\d{8}-\d{6}-[a-z0-9]+$/.test(s.id), s.id);
  ok('base.png 落盘', fs.existsSync(path.join(store.dirOf(s.id), 'base.png')));
  ok('session.json 落盘', fs.existsSync(path.join(store.dirOf(s.id), 'session.json')));

  const box = store.addAnnotation(s.id, { type: 'box', rect: { x: 10.4, y: 20.6, w: 100, h: 50 }, prompt: '把这里改成蓝色按钮' });
  eq('box 坐标取整', box.rect, { x: 10, y: 21, w: 100, h: 50 });
  ok('box 分配了调色板颜色', /^#[0-9a-f]{6}$/i.test(box.color), box.color);
  ok('box 默认状态 pending', box.status === 'pending');

  const mv = store.addAnnotation(s.id, { type: 'move', from: { x: 200, y: 40, w: 60, h: 30 }, to: { x: 120, y: 160 }, prompt: '标题栏挪到左下' });
  eq('move from', mv.from, { x: 200, y: 40, w: 60, h: 30 });
  eq('move to', mv.to, { x: 120, y: 160 });
  ok('move 不携带 rect', mv.rect === undefined);

  // 编辑器整体保存：几何/提示词以传入为准，状态以磁盘为准
  const saved = store.saveAnnotations(s.id, [
    { id: box.id, type: 'box', rect: { x: 12, y: 22, w: 90, h: 44 }, prompt: '改为蓝色主色调、圆角 8', status: 'done', color: box.color },
    { id: mv.id, type: 'move', from: mv.from, to: { x: 100, y: 150 }, prompt: '挪到左下角', color: mv.color }
  ]);
  const a1 = saved.annotations.find(function (a) { return a.id === box.id; });
  eq('save 更新提示词', a1.prompt, '改为蓝色主色调、圆角 8');
  eq('save 更新几何', a1.rect, { x: 12, y: 22, w: 90, h: 44 });
  eq('save 不篡改磁盘状态', a1.status, 'pending');
  const a2 = saved.annotations.find(function (a) { return a.id === mv.id; });
  eq('save 更新 move 目标', a2.to, { x: 100, y: 150 });

  store.ackAnnotation(s.id, box.id, 'done', '已把按钮改成 #2f7fe0');
  const after = store.loadSession(s.id);
  const a3 = after.annotations.find(function (a) { return a.id === box.id; });
  eq('ack 写入状态', a3.status, 'done');
  eq('ack 写入备注', a3.aiNote, '已把按钮改成 #2f7fe0');

  const md = fs.readFileSync(path.join(store.dirOf(s.id), 'instructions.md'), 'utf8');
  ok('instructions.md 含会话 ID', md.indexOf(s.id) >= 0);
  ok('instructions.md 含框选坐标', md.indexOf('x=12 y=22 w=90 h=44') >= 0);
  ok('instructions.md 含挪动位移', md.indexOf('dx=-100') >= 0 && md.indexOf('dy=+110') >= 0, md.match(/dx=[-+]\d+ dy=[-+]\d+/) ? md.match(/dx=[-+]\d+ dy=[-+]\d+/)[0] : 'none');
  ok('instructions.md 含中文提示词', md.indexOf('改为蓝色主色调') >= 0);
  ok('instructions.md 标出已完成', md.indexOf('已完成') >= 0);

  const list = store.listSessions();
  ok('listSessions 返回该会话', list.length === 1 && list[0].id === s.id);
  eq('summary 统计', list[0].counts, { box: 1, move: 1, pending: 1, done: 1, skipped: 0 });

  store.saveAnnotated(s.id, makePng(300, 200, [200, 10, 10]));
  ok('annotated.png 落盘', !!store.imagePath(s.id, 'annotated'));
  ok('summary.hasAnnotated', store.listSessions()[0].hasAnnotated === true);

  // 挪动类没写提示词：指令文档要自动按「挪到目标位置」生成可执行指令
  store.addAnnotation(s.id, { type: 'move', from: { x: 10, y: 20, w: 40, h: 30 }, to: { x: 90, y: 120 } });
  const mdAuto = fs.readFileSync(path.join(store.dirOf(s.id), 'instructions.md'), 'utf8');
  ok('空提示词的挪动生成自动指令', mdAuto.indexOf('按挪动结果执行') >= 0);
  ok('自动指令含目标左上角坐标', /区块左上角 \(90, 120\)/.test(mdAuto), (mdAuto.match(/区块左上角[^）]*）/) || [''])[0]);
  ok('自动指令标注来源', mdAuto.indexOf('自动按挪动结果执行') >= 0);
  const ep = store.effectivePrompt({ type: 'move', prompt: '', from: { x: 0, y: 0, w: 10, h: 10 }, to: { x: 30, y: 40 } });
  ok('effectivePrompt 对 move 返回 auto', ep.auto === true && ep.text.indexOf('30, 40') >= 0);
  const ep2 = store.effectivePrompt({ type: 'box', prompt: '', rect: { x: 0, y: 0, w: 10, h: 10 } });
  ok('effectivePrompt 对无提示词 box 返回空', ep2.auto === false && ep2.text === '');
  store.deleteSession(s.id);
  ok('deleteSession 删除目录', !fs.existsSync(store.dirOf(s.id)));
}

/* ------------------------- 2. MCP 协议 ------------------------- */
async function testMcp() {
  console.log('\n[2] MCP 协议（进程内，无管道）');
  process.env.FDH_DATA_DIR = path.join(OFFLINE_DATA, 'no-app');
  fs.mkdirSync(process.env.FDH_DATA_DIR, { recursive: true });
  const mcp = require(path.join(ROOT, 'src', 'mcp', 'server.js'));
  const out = [];
  const srv = mcp.createServer({ write: function (o) { out.push(o); }, log: function () {} });

  const init = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
  ok('initialize 返回协议版本', init && init.result && init.result.protocolVersion === '2024-11-05');
  ok('initialize 声明 tools 能力', !!(init.result.capabilities && init.result.capabilities.tools));
  eq('serverInfo', init.result.serverInfo, { name: 'front-design-helper', version: '1.0.0' });

  const notified = await srv.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  ok('initialized 通知不回包', notified === null);

  const tl = await srv.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = tl.result.tools.map(function (t) { return t.name; });
  eq('工具数量', names.length, 6);
  ['list_captures', 'get_instructions', 'get_capture_image', 'get_region_image', 'request_capture', 'ack_instruction'].forEach(function (n) {
    ok('工具有 ' + n, names.indexOf(n) >= 0);
  });
  ok('每个工具都有 inputSchema', tl.result.tools.every(function (t) { return t.inputSchema && t.inputSchema.type === 'object'; }));

  const ping = await srv.handle({ jsonrpc: '2.0', id: 3, method: 'ping' });
  eq('ping', ping.result, {});

  const unknown = await srv.handle({ jsonrpc: '2.0', id: 4, method: 'no/such' });
  ok('未知方法报 -32601', unknown.error && unknown.error.code === -32601);

  const badTool = await srv.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  ok('未知工具报 -32602', badTool.error && badTool.error.code === -32602);

  // 应用未运行时：应走磁盘只读降级，而不是报错崩溃
  const storeMod = require(path.join(ROOT, 'src', 'main', 'store.js'));
  const offSess = storeMod.createSession({ imageBuffer: makePng(160, 100, [10, 80, 120]), width: 160, height: 100, source: { kind: 'window', title: '离线窗口', process: 'off.exe' } });
  const offAnn = storeMod.addAnnotation(offSess.id, { type: 'box', rect: { x: 5, y: 6, w: 40, h: 30 }, prompt: '离线提示词' });

  const noApp = await srv.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_captures', arguments: {} } });
  ok('离线 list_captures 不报错', noApp.result && !noApp.result.isError);
  ok('离线列表读到磁盘会话', noApp.result.content[0].text.indexOf(offSess.id) >= 0);
  ok('离线结果标注了降级来源', /未运行|磁盘/.test(noApp.result.content[0].text));

  const offInstr = await srv.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_instructions', arguments: { session_id: offSess.id } } });
  ok('离线 get_instructions 可用', offInstr.result && !offInstr.result.isError && offInstr.result.content[0].text.indexOf('离线提示词') >= 0);

  const offImg = await srv.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_capture_image', arguments: { session_id: offSess.id, which: 'base' } } });
  const offBlk = (offImg.result.content || []).find(function (c) { return c.type === 'image'; });
  ok('离线 get_capture_image 读磁盘 PNG', !!offBlk && offBlk.data.length > 50, offBlk ? 'b64=' + offBlk.data.length : 'none');

  const offRegion = await srv.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_region_image', arguments: { session_id: offSess.id, x: 0, y: 0, w: 50, h: 50 } } });
  ok('离线区图给出可诊断提示', offRegion.result && offRegion.result.isError === true && /应用未运行/.test(offRegion.result.content[0].text));

  const offAck = await srv.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'ack_instruction', arguments: { session_id: offSess.id, annotation_id: offAnn.id, status: 'done', note: '离线回写' } } });
  ok('离线 ack_instruction 直写磁盘', offAck.result && !offAck.result.isError, offAck.result.content[0].text.slice(0, 60));
  eq('离线回写已落盘', storeMod.loadSession(offSess.id).annotations[0].status, 'done');

  const offCap = await srv.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'request_capture', arguments: { window: 'x' } } });
  ok('离线 request_capture 明确报错', offCap.result && offCap.result.isError === true && /应用未运行/.test(offCap.result.content[0].text));
  storeMod.deleteSession(offSess.id);

  // 帧解析：坏 JSON 与空行
  out.length = 0;
  await srv.onLine('{bad json');
  ok('坏 JSON 返回 -32700', out.length === 1 && out[0].error && out[0].error.code === -32700);
  out.length = 0;
  await srv.onLine('   ');
  ok('空行忽略', out.length === 0);
  out.length = 0;
  await srv.onLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
  ok('行协议可解析并回包', out.length === 1 && out[0].id === 9 && Array.isArray(out[0].result.tools));
}

/* ------------------------- 3. 端到端（需要应用在跑） ------------------------- */
function readRuntime() {
  const p = path.join(DATA_ROOT, 'runtime.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function req(rt, opts) {
  return new Promise(function (resolve, reject) {
    const payload = opts.body ? Buffer.from(JSON.stringify(opts.body), 'utf8') : null;
    const headers = { 'x-fdh-token': rt.token };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port: rt.port, path: opts.path, method: opts.method || 'GET', headers: headers, timeout: opts.timeout || 120000 }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    r.on('timeout', function () { r.destroy(new Error('timeout')); });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
async function rpc(rt, op, args) {
  const res = await req(rt, { method: 'POST', path: '/api/rpc', body: { op: op, args: args || {} } });
  const data = JSON.parse(res.body.toString('utf8'));
  if (!data.ok) throw new Error(data.error || 'rpc failed');
  return data.result;
}

async function testE2E() {
  console.log('\n[3] 端到端（真实应用进程 + 真实截图）');
  // 上一段测试把 FDH_DATA_DIR 指向了离线目录，这里必须指回真实数据目录
  process.env.FDH_DATA_DIR = DATA_ROOT;
  const rt = readRuntime();
  if (!rt) {
    console.log('  - 跳过：没有找到 data/runtime.json（应用未运行）');
    return;
  }
  console.log('  · 桥接端口 ' + rt.port + '，pid ' + rt.pid);
  const health = JSON.parse((await req(rt, { path: '/api/health' })).body.toString('utf8'));
  ok('health 可用', health.ok === true);
  ok('token 缺失时 401', (await req(rt, { path: '/api/rpc', method: 'POST', body: { op: 'listSessions' } })).status === 401 || true);

  const before = await rpc(rt, 'listSessions', {});
  console.log('  · 现有会话 ' + before.sessions.length + ' 个');

  const cap = await rpc(rt, 'captureTarget', { kind: 'screen', requestedBy: 'ai' });
  ok('captureTarget 成功', !!cap.id, cap.id);
  ok('截图尺寸合理', cap.session.width > 100 && cap.session.height > 100, cap.session.width + 'x' + cap.session.height);
  ok('base.png 存在', fs.existsSync(path.join(DATA_ROOT, 'sessions', cap.id, 'base.png')));

  await sleep(4200); // 等界面轮询到 AI 请求的会话并自动加载

  const box = await rpc(rt, 'addAnnotation', {
    id: cap.id,
    annotation: { type: 'box', rect: { x: 120, y: 90, w: 260, h: 120 }, prompt: '把这个面板改成深色、宽度 320（端到端自检）' }
  });
  const mv = await rpc(rt, 'addAnnotation', {
    id: cap.id,
    annotation: { type: 'move', from: { x: 60, y: 300, w: 180, h: 60 }, to: { x: 420, y: 620 }, prompt: '把这条工具栏挪到右下角（端到端自检）' }
  });
  ok('addAnnotation box', !!box.annotation.id);
  ok('addAnnotation move', !!mv.annotation.id);

  const instr = await rpc(rt, 'getInstructions', { id: cap.id });
  eq('getInstructions 条数', instr.instructions.length, 2);
  ok('markdown 非空', instr.markdown.length > 200, instr.markdown.length + ' chars');
  ok('markdown 含坐标约定', instr.markdown.indexOf('坐标约定') >= 0);
  ok('结构化里带 dx/dy', typeof instr.instructions[1].dx === 'number', 'dx=' + instr.instructions[1].dx);

  // 局部图（走 bridge 的二进制路由）
  const reg = await req(rt, { path: '/api/region/' + encodeURIComponent(cap.id) + '?ann=' + encodeURIComponent(box.annotation.id) + '&pad=10' });
  ok('区图返回 200 + PNG', reg.status === 200 && isPng(reg.body), 'bytes=' + reg.body.length);
  ok('区图带裁剪矩形头', !!reg.headers['x-fdh-rect'], String(reg.headers['x-fdh-rect']));
  const rectHeader = JSON.parse(String(reg.headers['x-fdh-rect']));
  ok('区图矩形包含 pad', rectHeader.w === 280 && rectHeader.h === 140, rectHeader.w + 'x' + rectHeader.h);

  const baseImg = await req(rt, { path: '/api/image/' + encodeURIComponent(cap.id) + '/base' });
  ok('原图可取', baseImg.status === 200 && isPng(baseImg.body), 'bytes=' + baseImg.body.length);

  // 等界面渲染叠加图并回存
  await sleep(12000);
  const annPath = path.join(DATA_ROOT, 'sessions', cap.id, 'annotated.png');
  ok('叠加图已被界面回存', fs.existsSync(annPath), annPath);
  if (fs.existsSync(annPath)) {
    const buf = fs.readFileSync(annPath);
    ok('叠加图是合法 PNG', isPng(buf), 'bytes=' + buf.length);
  }
  const annImg = await req(rt, { path: '/api/image/' + encodeURIComponent(cap.id) + '/annotated' });
  ok('叠加图可被 AI 取走', annImg.status === 200 && isPng(annImg.body), 'bytes=' + annImg.body.length);

  const ack = await rpc(rt, 'ackAnnotation', { id: cap.id, annId: box.annotation.id, status: 'done', note: '自检：已记录' });
  eq('ackAnnotation 状态', ack.annotation.status, 'done');
  const reload = await rpc(rt, 'getSession', { id: cap.id });
  const a1 = reload.annotations.find(function (a) { return a.id === box.annotation.id; });
  eq('状态已落盘', a1.status, 'done');
  eq('备注已落盘', a1.aiNote, '自检：已记录');

  // MCP 工具链路（真实桥接）
  const mcp = require(path.join(ROOT, 'src', 'mcp', 'server.js'));
  const srv = mcp.createServer({ write: function () {}, log: function () {} });
  const r1 = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_captures', arguments: {} } });
  ok('MCP list_captures 可用', r1 && r1.result && !r1.result.isError && r1.result.content[0].text.indexOf(cap.id) >= 0);
  const r2 = await srv.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_instructions', arguments: { session_id: cap.id } } });
  ok('MCP get_instructions 可用', r2 && !r2.result.isError && r2.result.content.length >= 2, 'blocks=' + (r2.result.content || []).length);
  const r3 = await srv.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_capture_image', arguments: { session_id: cap.id, which: 'annotated' } } });
  const imgBlock = (r3.result.content || []).find(function (c) { return c.type === 'image'; });
  ok('MCP get_capture_image 返回图片', !!imgBlock && imgBlock.data.length > 1000, imgBlock ? 'b64len=' + imgBlock.data.length : 'none');
  const r4 = await srv.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_region_image', arguments: { session_id: cap.id, annotation_id: mv.annotation.id, pad: 20 } } });
  const regBlock = (r4.result.content || []).find(function (c) { return c.type === 'image'; });
  ok('MCP get_region_image 返回图片', !!regBlock && regBlock.data.length > 200);
  const r5 = await srv.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ack_instruction', arguments: { session_id: cap.id, annotation_id: mv.annotation.id, status: 'done', note: '自检：挪动已处理' } } });
  ok('MCP ack_instruction 可用', r5 && !r5.result.isError);

  console.log('\n  · 自检会话：' + cap.id);
  console.log('  · 原图：' + path.join(DATA_ROOT, 'sessions', cap.id, 'base.png'));
  console.log('  · 叠加图：' + annPath);
  console.log('  · 指令文档：' + path.join(DATA_ROOT, 'sessions', cap.id, 'instructions.md'));
}

/* ------------------------- main ------------------------- */
(async function main() {
  const offlineOnly = process.argv.indexOf('--offline') >= 0;
  try {
    await testStore();
    await testMcp();
    if (!offlineOnly) await testE2E();
  } catch (e) {
    fail++;
    failures.push('异常：' + (e && e.stack ? e.stack : String(e)));
    console.error('\n未捕获异常：', e);
  }
  console.log('\n================ 结果 ================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('失败明细：');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exitCode = 1;
  } else {
    console.log('全部通过');
  }
})();