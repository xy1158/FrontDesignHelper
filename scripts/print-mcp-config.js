#!/usr/bin/env node
'use strict';
// 打印可粘贴到 MCP 客户端的配置片段（路径按本机实际位置生成）
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const serverJs = path.join(ROOT, 'src', 'mcp', 'server.js');
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

console.log('FrontDesignHelper MCP 配置');
console.log('项目目录: ' + ROOT);
console.log('MCP 服务: ' + serverJs);
console.log('应用本体: ' + electronExe + (fs.existsSync(electronExe) ? '' : '  [缺失]'));
console.log('');
console.log('通用（Claude Desktop / Cursor / Codex / DSH 等）mcpServers 配置：');
console.log(JSON.stringify({
  mcpServers: {
    'front-design-helper': {
      command: process.execPath,
      args: [serverJs]
    }
  }
}, null, 2));
console.log('');
console.log('说明：AI 端只需要这个 stdio 服务；它会在应用运行时自动连上本地桥接端口（data/runtime.json）。');