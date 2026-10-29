#!/usr/bin/env node
'use strict';
// 用真实 stdio 管道启动 MCP 服务（模拟真实 MCP 客户端），验证帧协议与工具链路。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
// 可用 FDH_DATA_DIR 指向任意数据目录（例如打包版落在 %APPDATA% 下的那份）
const { dataRoot } = require('./_env');
const DATA_ROOT = dataRoot();
const SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');
const TIMEOUT = 90000;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });

const pending = new Map();
let buf = '';
let stderrText = '';

child.stderr.on('data', (d) => { stderrText += d.toString(); });

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { console.log('  ! 非 JSON 输出: ' + line.slice(0, 120)); continue; }
    const resolver = pending.get(msg.id);
    if (resolver) { pending.delete(msg.id); resolver(msg); }
  }
});

let seq = 100;
function send(method, params) {
  const id = seq++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('超时: ' + method)); }, TIMEOUT);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    child.stdin.write(payload + '\n');
  });
}

function call(name, args) { return send('tools/call', { name: name, arguments: args || {} }); }

function textOf(res) {
  return (res.result && res.result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

(async function main() {
  console.log('[stdio] 启动: node ' + path.relative(ROOT, SERVER));
  try {
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'fdh-stdio-check', version: '1.0.0' }
    });
    ok('initialize 成功', init.result && init.result.protocolVersion === '2024-11-05', init.result && init.result.serverInfo && init.result.serverInfo.name);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tl = await send('tools/list');
    ok('tools/list 返回 6 个工具', tl.result && tl.result.tools.length === 6, tl.result ? tl.result.tools.map((t) => t.name).join(',') : '');

    const list = await call('list_captures');
    const listText = textOf(list);
    ok('list_captures 有内容', listText.length > 20, listText.split('\n')[0]);

    // 用真实窗口名截一张（窗口模式）：先看有哪些窗口
    const winsRpc = await call('request_capture', { window: '__definitely_not_a_window__' });
    const errText = textOf(winsRpc);
    ok('未匹配到窗口时给出可用窗口列表', /没有匹配/.test(errText) && /- /.test(errText), errText.split('\n')[0]);

    // 真正截一个窗口（选标题最长的可见窗口，通常是浏览器/编辑器）
    const m = errText.match(/- ([^|\n]+) \| ([^\n]+)/g) || [];
    let want = null;
    if (m.length) want = m[0].replace(/^- /, '').split(' | ')[1].trim().slice(0, 12);
    if (want) {
      const cap = await call('request_capture', { window: want });
      const capText = textOf(cap);
      ok('request_capture 成功截取窗口', /已截取窗口/.test(capText) && !(cap.result && cap.result.isError), (capText.split('\n')[0] || '').slice(0, 100));
      const idMatch = capText.match(/新会话 (cap-[a-z0-9-]+)/);
      ok('返回新会话 ID', !!idMatch, idMatch ? idMatch[1] : '');

      if (idMatch) {
        const instr = await call('get_instructions', { session_id: idMatch[1] });
        const it = textOf(instr);
        ok('get_instructions 可读', /视觉标注指令/.test(it) || /标注/.test(it), 'len=' + it.length);
        const img = await call('get_capture_image', { session_id: idMatch[1], which: 'base' });
        const blk = (img.result.content || []).find((c) => c.type === 'image');
        ok('get_capture_image 返回 base64 图片', !!blk && blk.data.length > 10000, blk ? 'b64=' + blk.data.length : 'none');
        const reg = await call('get_region_image', { session_id: idMatch[1], x: 0, y: 0, w: 400, h: 300 });
        const rb = (reg.result.content || []).find((c) => c.type === 'image');
        ok('get_region_image 可指定任意矩形', !!rb && rb.data.length > 1000, rb ? 'b64=' + rb.data.length : 'none');
        // 落盘证据
        const sessDir = path.join(DATA_ROOT, 'sessions', idMatch[1]);
        ok('会话目录已生成', fs.existsSync(path.join(sessDir, 'session.json')));
        ok('instructions.md 已生成', fs.existsSync(path.join(sessDir, 'instructions.md')));
        const sess = JSON.parse(fs.readFileSync(path.join(sessDir, 'session.json'), 'utf8'));
        ok('窗口截取方式记录在案', !!sess.source.method, 'method=' + sess.source.method + ' ' + sess.image.width + 'x' + sess.image.height);
        ok('截图尺寸与窗口矩形接近', Math.abs(sess.image.width - sess.source.rect.w) <= 40 && Math.abs(sess.image.height - sess.source.rect.h) <= 60,
          'img=' + sess.image.width + 'x' + sess.image.height + ' rect=' + sess.source.rect.w + 'x' + sess.source.rect.h);
        // 置前是否成功取决于系统当时是否允许前台切换（用户正在操作时可能被拒）。
        // 这里只要求「如实上报」，不把环境因素当成失败。
        ok('置前状态已如实上报', typeof sess.source.foreground === 'boolean', 'foreground=' + sess.source.foreground + (sess.source.foreground ? '（已置前）' : '（系统拒绝，已提示遮挡风险）'));
      }
    } else {
      ok('存在可截取的窗口', false, '窗口列表为空');
    }
  } catch (e) {
    fail++;
    console.log('  \u2717 异常: ' + (e && e.message ? e.message : e));
  } finally {
    try { child.stdin.end(); } catch (e) { }
    try { child.kill(); } catch (e) { }
  }
  if (stderrText.trim()) console.log('\n[stderr]\n' + stderrText.trim().split('\n').slice(0, 6).join('\n'));
  console.log('\n结果：通过 ' + pass + '，失败 ' + fail);
  process.exitCode = fail ? 1 : 0;
})();