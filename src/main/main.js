'use strict';
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const api = require('./api');
const bridge = require('./bridge');
const P = require('./paths');

const DEV = process.argv.indexOf('--dev') >= 0;

// 打包运行时，代码所在目录是只读/临时解压目录，数据必须落到用户目录，
// 否则 portable 版退出后会话会随临时目录一起消失。
if (app.isPackaged && !process.env.FDH_DATA_DIR) {
  try { process.env.FDH_DATA_DIR = path.join(app.getPath('userData'), 'data'); } catch (e) { /* 保持默认 */ }
}

let mainWindow = null;
let bridgeHandle = null;
let logPath = null;

function log() {
  try {
    const parts = Array.prototype.slice.call(arguments).map((x) => {
      if (typeof x === 'string') return x;
      try { return JSON.stringify(x); } catch (e) { return String(x); }
    });
    const line = '[' + new Date().toISOString() + '] ' + parts.join(' ');
    if (!logPath) logPath = path.join(P.dataDir(), 'app.log');
    try {
      const st = fs.existsSync(logPath) ? fs.statSync(logPath) : null;
      if (st && st.size > 4 * 1024 * 1024) fs.renameSync(logPath, logPath + '.1');
    } catch (e) { /* ignore */ }
    fs.appendFileSync(logPath, line + '\n', 'utf8');
    if (DEV) process.stdout.write(line + '\n');
  } catch (e) { /* 日志失败不影响主流程 */ }
}

process.on('uncaughtException', (e) => { log('uncaughtException', e && e.stack ? e.stack : String(e)); });
process.on('unhandledRejection', (e) => { log('unhandledRejection', e && e.stack ? e.stack : String(e)); });

// 把已有窗口顶到用户眼前：还原 → 显示 → 临时置顶 → 闪任务栏。
function bringToFront() {
  if (!mainWindow) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(true);
    setTimeout(function () {
      try { mainWindow.setAlwaysOnTop(false); mainWindow.flashFrame(false); } catch (e) { /* ignore */ }
    }, 1400);
  } catch (e) { log('bringToFront failed: ' + (e && e.message ? e.message : e)); }
}

if (!app.requestSingleInstanceLock()) {
  // 第二个实例：以前这里是静默 app.quit()，用户会以为「双击没反应」。现在明确告知。
  app.whenReady().then(function () {
    const quiet = process.argv.indexOf('--quiet-second-instance') >= 0;
    if (!quiet) try {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'FrontDesignHelper 已在运行',
        message: '软件已经在运行中，已在后台把它的窗口切到前台。',
        detail: '如果仍然看不到窗口：可能被其它窗口完全挡住，或在任务栏里（看一下任务栏的 FrontDesignHelper）。',
        buttons: ['好']
      });
    } catch (e) { /* 弹窗失败也不阻塞退出 */ }
    app.quit();
  }).catch(function () { app.quit(); });
} else {
  app.on('second-instance', function () { bringToFront(); });
  app.whenReady().then(boot).catch((e) => {
    log('boot failed', e && e.stack ? e.stack : String(e));
    try { dialog.showErrorBox('FrontDesignHelper 启动失败', String((e && e.stack) || e)); } catch (err) { /* ignore */ }
    app.quit();
  });
}

function iconPath() {
  const p = path.join(__dirname, '..', '..', 'assets', 'fdh.ico');
  try { return fs.existsSync(p) ? p : undefined; } catch (e) { return undefined; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1180,
    minHeight: 700,
    backgroundColor: '#0b0e13',
    title: 'FrontDesignHelper',
    icon: iconPath(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler((info) => {
    try { shell.openExternal(info.url); } catch (e) { /* ignore */ }
    return { action: 'deny' };
  });
  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// UI 自检：把受控动作翻译成渲染进程里的合成 DOM 事件，然后回读界面快照。
// 动作类型固定：tool / drag / click / prompt / key / inspect，不接受任意脚本。
async function runUiActions(win, actions) {
  const script = 'window.__fdhDebugRun(' + JSON.stringify(actions) + ')';
  return await win.webContents.executeJavaScript(script, true);
}

function registerIpc() {
  ipcMain.handle('fdh:api', async (event, payload) => {
    const p = payload || {};
    const op = p.op;
    const args = p.args || {};
    try {
      const result = await api.dispatch(op, args);
      if (op === 'captureTarget' && mainWindow) {
        try { mainWindow.show(); mainWindow.focus(); } catch (e) { /* ignore */ }
      }
      return { ok: true, result: result };
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      log('api error', op, msg);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('fdh:openDataDir', async () => {
    const dir = P.dataDir();
    const err = await shell.openPath(dir);
    return { ok: !err, path: dir, error: err || '' };
  });

  ipcMain.handle('fdh:copyText', async (event, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  ipcMain.handle('fdh:bridgeInfo', async () => ({
    ok: true,
    port: bridgeHandle ? bridgeHandle.port : 0,
    mcpAvailable: !!bridgeHandle,
    runtimeFile: P.runtimeFile(),
    dataDir: P.dataDir()
  }));

  ipcMain.handle('fdh:openExternal', async (event, url) => {
    try { await shell.openExternal(String(url)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });
}

async function boot() {
  app.setAppUserModelId('com.fdh.frontdesignhelper');
  log('boot', { electron: process.versions.electron, node: process.versions.node, dataDir: P.dataDir() });
  createWindow();
  registerIpc();
  api.setSelfCapture(async function () {
    if (!mainWindow) throw new Error('没有窗口');
    const img = await mainWindow.webContents.capturePage();
    return img.toPNG();
  });
  api.events.on('session-created', function (payload) {
    if (!mainWindow) return;
    try { mainWindow.webContents.send('fdh:event', Object.assign({ type: 'session-created' }, payload)); } catch (e) { /* ignore */ }
  });
  api.setClipboard(async function (text) { clipboard.writeText(String(text == null ? '' : text)); return true; });
  api.setPickDirectory(async function () {
    const r = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择 AI 要在其中工作的目录（工作区）',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '用这个目录'
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true, path: '' };
    return { canceled: false, path: r.filePaths[0] };
  });
  api.setWindowGuard({
    conceal: async function () {
      if (!mainWindow) return;
      mainWindow.hide();
      await new Promise(function (r) { setTimeout(r, 220); });
    },
    restore: async function () {
      if (!mainWindow) return;
      mainWindow.show();
      mainWindow.focus();
      await new Promise(function (r) { setTimeout(r, 120); });
    },
    minimize: async function () {
      if (!mainWindow) return;
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.minimize();
      await new Promise(function (r) { setTimeout(r, 120); });
    },
    show: async function () {
      if (!mainWindow) return;
      mainWindow.show();
      mainWindow.focus();
    }
  });
  api.setDebugUi(async function (actions) {
    if (!mainWindow) throw new Error('没有窗口');
    return await runUiActions(mainWindow, actions);
  });
  try {
    bridgeHandle = await bridge.start({ dispatch: api.dispatch, version: api.VERSION });
    log('bridge listening', { port: bridgeHandle.port, runtime: P.runtimeFile() });
  } catch (e) {
    log('bridge failed', e && e.message ? e.message : String(e));
    bridgeHandle = null;
    if (mainWindow) {
      mainWindow.webContents.once('did-finish-load', () => {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'MCP 通道未启动',
          message: '本地 MCP 桥接端口启动失败，界面仍可使用，但 AI 无法连接。',
          detail: String((e && e.message) || e),
          buttons: ['知道了']
        });
      });
    }
  }
}

app.on('window-all-closed', () => { app.quit(); });

app.on('will-quit', () => {
  log('will-quit');
  if (bridgeHandle) {
    try { bridgeHandle.close(); } catch (e) { /* ignore */ }
    bridgeHandle = null;
  }
});