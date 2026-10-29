'use strict';
// 数据目录解析优先级：
//   1. FDH_DATA_DIR 环境变量（测试/多实例隔离用）
//   2. %APPDATA%\FrontDesignHelper\data（安装版与源码版共用同一份历史）
//   3. <项目>/data（无 APPDATA 时的兜底）
// 说明：早期版本源码版用 <项目>/data、安装版用 %APPDATA%，导致两个入口看到不同的历史，
// 用户会以为「上一次的截图和提示词丢了」。现在统一到同一处。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function defaultDir() {
  const appData = process.env.APPDATA || process.env.XDG_CONFIG_HOME;
  if (appData) return path.join(appData, 'FrontDesignHelper', 'data');
  return path.join(ROOT, 'data');
}

function dataDir() {
  // 注意：不要缓存。自检脚本/多实例场景会在同一进程内切换 FDH_DATA_DIR。
  const d = process.env.FDH_DATA_DIR ? path.resolve(process.env.FDH_DATA_DIR) : defaultDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function sessionsDir() {
  const d = path.join(dataDir(), 'sessions');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function sessionDir(id) {
  return path.join(sessionsDir(), id);
}

function runtimeFile() {
  return path.join(dataDir(), 'runtime.json');
}

function tasksDir() {
  const d = path.join(dataDir(), 'tasks');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = { ROOT, dataDir, sessionsDir, sessionDir, runtimeFile, tasksDir, defaultDir };