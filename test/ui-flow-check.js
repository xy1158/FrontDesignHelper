#!/usr/bin/env node
'use strict';
// 真实交互自检：用受控合成指针事件驱动界面，验证「框选 -> 自动生成提示词条目 -> 保存」
// 与「截取区块并挪动」。需要应用在运行。
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 可用 FDH_DATA_DIR 指向任意数据目录（例如打包版落在 %APPDATA% 下的那份）
const { dataRoot } = require('./_env');
const DATA_ROOT = dataRoot();
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const r = http.request({ host: '127.0.0.1', port: rt.port, path: opts.path, method: opts.method || 'GET', headers: headers, timeout: 120000 }, function (res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
async function rpc(rt, op, args) {
  const res = await req(rt, { method: 'POST', path: '/api/rpc', body: { op, args: args || {} } });
  const data = JSON.parse(res.body.toString('utf8'));
  if (!data.ok) throw new Error(data.error || 'rpc failed');
  return data.result;
}

(async function main() {
  const rt = readRuntime();
  if (!rt) { console.log('跳过：应用未运行'); process.exitCode = 0; return; }
  console.log('[ui] 桥接端口 ' + rt.port);

  // 准备一个干净的会话（整屏截取）
  const cap = await rpc(rt, 'captureTarget', { kind: 'screen', requestedBy: 'ai' });
  const id = cap.id;
  console.log('  · 新会话 ' + id + '（' + cap.session.width + 'x' + cap.session.height + '）');
  // 等界面真正加载到这个会话（事件驱动，最多 15 秒）
  let loaded = null;
  for (let i = 0; i < 40; i++) {
    const s = await rpc(rt, 'debugUi', { actions: [] });
    if (s.sessionId === id && s.imageLoaded === true && s.emptyVisible === false) { loaded = s; break; }
    await sleep(400);
  }
  ok('界面自动加载了新会话（含图片解码完成）', !!loaded, loaded ? 'zoom=' + loaded.zoom : 'timeout');

  // 1) 框选：拖出区域 -> 右侧自动生成条目并聚焦
  let snap = await rpc(rt, 'debugUi', { actions: [
    { type: 'tool', name: 'box' },
    { type: 'drag', x1: 240, y1: 200, x2: 460, y2: 330 }
  ] });
  ok('框选后生成 1 条提示词条目', snap.cards === 1, 'cards=' + snap.cards);
  ok('自动聚焦到新条目输入框', snap.focusedIndex === 0, 'focused=' + snap.focusedIndex);
  ok('新条目提示词为空', snap.prompts[0] === '', 'got=' + JSON.stringify(snap.prompts[0]));
  ok('框选后自动切回选择工具', snap.tool === 'select', 'tool=' + snap.tool);
  ok('图片区显示了坐标读数', /x=-?\d+ y=-?\d+/.test(snap.coords), snap.coords);
  ok('卡片显示了区域坐标', /^\d+,\d+ · \d+×\d+$/.test(snap.positions[0] || ''), String(snap.positions[0]));

  // 2) 输入提示词 -> 自动保存
  snap = await rpc(rt, 'debugUi', { actions: [
    { type: 'prompt', index: 0, text: '把这个面板改成深色卡片、宽度 320（UI 自检）' }
  ] });
  ok('提示词写入输入框', String(snap.prompts[0] || '').indexOf('深色卡片') >= 0, String(snap.prompts[0]));
  await sleep(1600);
  let sess = await rpc(rt, 'getSession', { id: id });
  ok('提示词已自动落盘', sess.annotations.length === 1 && String(sess.annotations[0].prompt || '').indexOf('深色卡片') >= 0, String((sess.annotations[0] || {}).prompt));
  const boxAnn = sess.annotations[0];
  ok('框选几何有效', boxAnn.type === 'box' && boxAnn.rect.w > 10 && boxAnn.rect.h > 10, JSON.stringify(boxAnn.rect));

  // 3) 挪动：拖出区块 -> 单击放置
  snap = await rpc(rt, 'debugUi', { actions: [
    { type: 'tool', name: 'move' },
    { type: 'drag', x1: 260, y1: 420, x2: 430, y2: 500 },
    { type: 'click', x: 620, y: 560 }
  ] });
  ok('挪动后生成第 2 条条目', snap.cards === 2, 'cards=' + snap.cards);
  ok('挪动条目也被聚焦', snap.focusedIndex === 1, 'focused=' + snap.focusedIndex);
  await rpc(rt, 'debugUi', { actions: [{ type: 'prompt', index: 1, text: '把这条工具栏挪到右下角（UI 自检）' }] });
  await sleep(1800);
  sess = await rpc(rt, 'getSession', { id: id });
  const mvAnn = sess.annotations[1];
  ok('挪动标注已落盘', !!mvAnn && mvAnn.type === 'move', mvAnn ? mvAnn.type : 'missing');
  ok('记录了源区域', !!mvAnn && mvAnn.from.w > 10 && mvAnn.from.h > 10, mvAnn ? JSON.stringify(mvAnn.from) : '');
  ok('位移方向正确（右下）', !!mvAnn && mvAnn.to.x > mvAnn.from.x && mvAnn.to.y > mvAnn.from.y,
    mvAnn ? 'from=' + mvAnn.from.x + ',' + mvAnn.from.y + ' to=' + mvAnn.to.x + ',' + mvAnn.to.y : '');

  // 4) 叠加图应随交互更新
  await sleep(3000);
  const annPath = path.join(DATA_ROOT, 'sessions', id, 'annotated.png');
  ok('叠加意图图已生成', fs.existsSync(annPath));
  if (fs.existsSync(annPath)) {
    const st = fs.statSync(annPath);
    ok('叠加图是最近写出的', Date.now() - st.mtimeMs < 60000, 'age=' + Math.round((Date.now() - st.mtimeMs) / 1000) + 's');
  }

  // 5) 键盘：撤销 / 重做 / 删除
  snap = await rpc(rt, 'debugUi', { actions: [{ type: 'key', key: 'z', code: 'KeyZ', ctrl: true }] });
  ok('Ctrl+Z 撤销生效', snap.cards === 1, 'cards=' + snap.cards);
  snap = await rpc(rt, 'debugUi', { actions: [{ type: 'tool', name: 'move' }] });
  ok('工具可切换', snap.tool === 'move', 'tool=' + snap.tool);

  console.log('\n  · 会话 ' + id);
  console.log('\n结果：通过 ' + pass + '，失败 ' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.log('异常：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});