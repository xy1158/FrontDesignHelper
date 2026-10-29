'use strict';
// 一键让 AI 修改：在后台起一个 headless DSH 任务，它通过 MCP 读标注、改引擎、回写状态。
// 设计约束：同一时刻只允许一个任务；日志落盘；可取消；有最大运行时长兜底。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const dsh = require('./dsh');

const MAX_RUNTIME_MS = 20 * 60 * 1000;

let current = null; // { child, pid, startedAt, sessionId, logPath, exitCode, canceled, timer, fd }

function findNode() {
  const cands = [];
  if (process.env.FDH_NODE) cands.push(process.env.FDH_NODE);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  cands.push(path.join(pf, 'nodejs', 'node.exe'));
  const pathEnv = process.env.PATH || '';
  for (const part of pathEnv.split(';')) if (part) cands.push(path.join(part, 'node.exe'));
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

function findDsh() {
  const cands = [];
  if (process.env.FDH_DSH) cands.push(process.env.FDH_DSH);
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

function status() {
  if (!current) return { run: null };
  return {
    run: {
      pid: current.pid,
      startedAt: current.startedAt,
      sessionId: current.sessionId,
      workspace: current.workspace,
      continuedFrom: current.continuedFrom,
      logPath: current.logPath,
      running: current.exitCode === null,
      exitCode: current.exitCode,
      canceled: !!current.canceled,
      elapsedMs: Date.now() - new Date(current.startedAt).getTime()
    }
  };
}

function tailLog(logPath, lines) {
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    const all = text.split(/\r?\n/).filter(Boolean);
    return all.slice(-(lines || 12)).join('\n');
  } catch (e) { return ''; }
}

function start(args) {
  const a = args || {};
  if (current && current.exitCode === null) {
    throw new Error('已有一个 AI 修改任务在运行（开始于 ' + current.startedAt + '），先等它结束或点「停止」');
  }
  let prompt = String(a.prompt || '').trim();
  if (!prompt) throw new Error('指令不能为空');

  // 工作区（决定 cwd 与 DSH 归档位置）
  const workspace = a.workspace ? path.resolve(String(a.workspace)) : P.ROOT;
  if (!fs.existsSync(workspace)) throw new Error('工作区不存在: ' + workspace);

  // 继续某条已有对话：headless 不支持 --resume，改为把该对话最近内容拼进任务作为上下文
  let continuedFrom = '';
  let contextChars = 0;
  if (a.continueFrom) {
    try {
      const ctx = dsh.conversationContext(workspace, String(a.continueFrom));
      if (ctx) {
        continuedFrom = String(a.continueFrom);
        contextChars = ctx.length;
        prompt = '【这是继续上一条对话，以下是它的最近内容，作为背景参考】\n' + ctx +
          '\n\n【本次任务】\n' + prompt;
      }
    } catch (e) { /* 上下文取不到就当作新任务 */ }
  }
  const node = findNode();
  if (!node) throw new Error('找不到 node.exe，无法启动 AI 任务（可用环境变量 FDH_NODE 指定）');
  const dshBin = findDsh();
  if (!dshBin) throw new Error('找不到 DSH（@deepseek-ai/dsh），无法启动 AI 任务（可用环境变量 FDH_DSH 指定）');

  const logDir = path.join(P.dataDir(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'agent-' + Date.now() + '.log');
  let fd;
  try {
    fd = fs.openSync(logPath, 'a');
    fs.writeSync(fd, '[' + new Date().toISOString() + '] start session=' + (a.sessionId || '') + ' workspace=' + workspace + (continuedFrom ? (' continueFrom=' + continuedFrom + ' ctxChars=' + contextChars) : '') + '\n');
    fs.writeSync(fd, '[' + new Date().toISOString() + '] prompt:\n' + prompt + '\n---\n');
  } catch (e) {
    throw new Error('无法创建日志文件: ' + e.message);
  }

  const child = spawn(node, [dshBin, '--profile', 'headless', prompt], {
    cwd: workspace,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: Object.assign({}, process.env, { FDH_DATA_DIR: P.dataDir(), NO_COLOR: '1' })
  });

  const rec = {
    child: child,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    sessionId: a.sessionId || '',
    workspace: workspace,
    continuedFrom: continuedFrom,
    logPath: logPath,
    exitCode: null,
    canceled: false,
    fd: fd,
    timer: null
  };
  current = rec;

  rec.timer = setTimeout(function () {
    if (rec.exitCode !== null) return;
    rec.canceled = true;
    try { child.kill(); } catch (e) { /* ignore */ }
  }, MAX_RUNTIME_MS);

  child.on('error', function (err) {
    try { fs.writeSync(fd, '\n[' + new Date().toISOString() + '] spawn error: ' + err.message + '\n'); } catch (e) { /* ignore */ }
    rec.exitCode = -1;
    clearTimeout(rec.timer);
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  });

  child.on('exit', function (code) {
    rec.exitCode = (code === null ? -1 : code);
    clearTimeout(rec.timer);
    try { fs.writeSync(fd, '\n[' + new Date().toISOString() + '] exit code=' + rec.exitCode + '\n'); } catch (e) { /* ignore */ }
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  });

  return { pid: rec.pid, logPath: logPath, startedAt: rec.startedAt };
}

function cancel() {
  if (!current || current.exitCode !== null) throw new Error('没有正在运行的 AI 任务');
  current.canceled = true;
  try { current.child.kill(); } catch (e) { throw new Error('停止失败: ' + e.message); }
  return { pid: current.pid, canceled: true };
}

module.exports = { start, cancel, status, tailLog, findNode, findDsh };