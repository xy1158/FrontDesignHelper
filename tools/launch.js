#!/usr/bin/env node
'use strict';
// 开发期启动器：spawn Electron，stdio 重定向到文件、不用管道，等待子进程退出。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const exe = process.env.FDH_ELECTRON || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const logDir = path.join(ROOT, '.tmp');
fs.mkdirSync(logDir, { recursive: true });
const outFd = fs.openSync(path.join(logDir, 'electron-out.log'), 'a');
const errFd = fs.openSync(path.join(logDir, 'electron-err.log'), 'a');

console.log('[launch] exe=' + exe);
console.log('[launch] app=' + ROOT);

const child = spawn(exe, [ROOT], {
  cwd: ROOT,
  stdio: ['ignore', outFd, errFd],
  windowsHide: false,
  env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '1' })
});

child.on('error', (e) => { console.error('[launch] spawn error: ' + e.message); process.exit(1); });
child.on('exit', (code, signal) => {
  console.log('[launch] electron exited code=' + code + ' signal=' + signal);
  try { fs.closeSync(outFd); fs.closeSync(errFd); } catch (e) { }
  process.exit(code == null ? 0 : code);
});
process.on('SIGINT', () => { try { child.kill(); } catch (e) { } });