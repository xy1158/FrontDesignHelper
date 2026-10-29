#!/usr/bin/env node
'use strict';
// 打包前自检：所有 JS 能否被解析、package.json 能否解析、关键文件是否存在。
// 目的：避免「字面 \n」「漏括号」这类低级错误在构建后才以崩溃弹框的形式暴露给用户。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let bad = 0;

function checkJs(file) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(src, { filename: file });
  } catch (e) {
    bad++;
    console.log('  ✗ ' + path.relative(ROOT, file) + ' -> ' + e.message);
    return;
  }
  // 额外检查：源码里不应出现「字符串里夹着字面 \n」这种补丁残留
  if (/\\n {2,}(const|let|var|pasted|if|for)\b/.test(src)) {
    bad++;
    console.log('  ✗ ' + path.relative(ROOT, file) + ' -> 疑似把换行写成了字面 \\n');
  }
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
}

const files = [];
walk(path.join(ROOT, 'src'), files);
walk(path.join(ROOT, 'tools'), files);
walk(path.join(ROOT, 'test'), files);
files.forEach(checkJs);

// HTML 里引用的脚本存在吗
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
for (const m of html.matchAll(/<script src="\.\/([^"]+)"/g)) {
  const f = path.join(ROOT, 'src/renderer', m[1]);
  if (!fs.existsSync(f)) { bad++; console.log('  ✗ index.html 引用了不存在的脚本: ' + m[1]); }
}

// package.json
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.main) { bad++; console.log('  ✗ package.json 缺 main'); }
} catch (e) {
  bad++;
  console.log('  ✗ package.json 解析失败: ' + e.message);
}

console.log(bad ? ('\n检查失败：' + bad + ' 个问题') : ('\n检查通过：' + files.length + ' 个 JS 文件全部可解析'));
process.exitCode = bad ? 1 : 0;