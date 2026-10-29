'use strict';
// 测试用数据目录定位：与应用侧 MCP 服务保持一致。
// 优先级：FDH_DATA_DIR > 项目 data/（有 runtime.json 或 sessions）> 打包版 %APPDATA%\FrontDesignHelper\data
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function candidates() {
  const out = [];
  if (process.env.FDH_DATA_DIR) out.push(path.resolve(process.env.FDH_DATA_DIR));
  out.push(path.join(ROOT, 'data'));
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'FrontDesignHelper', 'data'));
  return out;
}

function hasRuntime(d) {
  try { return fs.existsSync(path.join(d, 'runtime.json')); } catch (e) { return false; }
}

function hasSessions(d) {
  try { return fs.existsSync(path.join(d, 'sessions')); } catch (e) { return false; }
}

function dataRoot() {
  const dirs = candidates();
  for (let i = 0; i < dirs.length; i++) if (hasRuntime(dirs[i])) return dirs[i];
  for (let i = 0; i < dirs.length; i++) if (hasSessions(dirs[i])) return dirs[i];
  return dirs[1];
}

module.exports = { ROOT, dataRoot, candidates };