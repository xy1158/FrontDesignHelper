#!/usr/bin/env node
'use strict';
// 安全停止本应用。
// 规则：只按 PID 精确结束，且必须能证明该 PID 是本项目的进程（可执行文件路径或命令行含项目目录）。
// 明确不做：按通用进程名批量杀（electron/node 等会误伤其它软件）。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.FDH_DATA_DIR || path.join(ROOT, 'data');
const APP_EXE = 'FrontDesignHelper.exe';

function runtimePid() {
  const rt = path.join(DATA_DIR, 'runtime.json');
  if (!fs.existsSync(rt)) return null;
  try {
    const pid = Number(JSON.parse(fs.readFileSync(rt, 'utf8')).pid);
    return Number.isFinite(pid) ? pid : null;
  } catch (e) { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function psLines(script) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// 本应用的进程：可执行文件名唯一（FrontDesignHelper.exe），再做路径归属校验
function ownPids() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='" + APP_EXE + "'\" | " +
    "ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ExecutablePath + '|' + $_.CommandLine }";
  const rows = [];
  for (const line of psLines(script)) {
    const parts = line.split('|');
    const pid = Number(parts[0]);
    const exe = parts[1] || '';
    const cmd = parts.slice(2).join('|') || '';
    if (!Number.isFinite(pid)) continue;
    const own = (exe && exe.toLowerCase().indexOf(ROOT.toLowerCase()) === 0) ||
      (cmd && cmd.toLowerCase().indexOf(ROOT.toLowerCase()) >= 0);
    if (own) rows.push({ pid, exe });
  }
  return rows;
}

function stop(pid) {
  const out = psLines("try { Stop-Process -Id " + pid + " -Force -ErrorAction Stop; 'stopped' } catch { 'not-running' }").join(' ');
  console.log('PID ' + pid + ' -> ' + out);
}

(function main() {
  const argPid = process.argv.slice(2).find((a) => /^--pid=/.test(a));
  let pid = argPid ? Number(argPid.split('=')[1]) : runtimePid();
  if (pid === process.pid || pid === process.ppid) {
    console.log('拒绝：目标 PID 是本脚本或其父进程');
    process.exit(1);
  }
  if (pid && alive(pid)) {
    const own = ownPids();
    if (!own.some((r) => r.pid === pid)) {
      console.log('拒绝：PID ' + pid + ' 不是本项目的进程（未在 ' + APP_EXE + ' 列表中找到匹配路径）');
      process.exit(1);
    }
    stop(pid);
  } else if (pid) {
    console.log('runtime.json 里的 PID ' + pid + ' 已不在运行（可能已手动关闭）');
  }
  // 兜底：清掉上次没关干净的本应用进程
  const leftovers = ownPids().filter((r) => r.pid !== process.pid);
  if (leftovers.length) {
    console.log('发现残留本应用进程 ' + leftovers.length + ' 个，一并停止');
    leftovers.forEach((r) => stop(r.pid));
  }
  try { fs.unlinkSync(path.join(DATA_DIR, 'runtime.json')); } catch (e) { /* ignore */ }
})();