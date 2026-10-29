'use strict';
// 本地回环 HTTP 桥：MCP 进程与自动化脚本通过它以完全相同的 op 访问内核。
// 只监听 127.0.0.1，除 /api/health 外一律要求 x-fdh-token。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const P = require('./paths');

const MAX_BODY = 64 * 1024 * 1024;

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function sendPng(res, buf, extra) {
  res.writeHead(200, Object.assign({
    'content-type': 'image/png',
    'content-length': buf.length,
    'cache-control': 'no-store'
  }, extra || {}));
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  try { return JSON.parse(text); } catch (e) { throw new Error('请求体不是合法 JSON'); }
}

function start(options) {
  const opts = options || {};
  const dispatch = opts.dispatch;
  const version = opts.version || '0.0.0';
  const token = crypto.randomBytes(24).toString('hex');
  const startedAt = new Date().toISOString();
  let port = 0;

  async function handleRpc(req, res) {
    const body = await parseJsonBody(req);
    const op = body && body.op;
    const args = (body && body.args) || {};
    if (!op) { sendJson(res, 400, { ok: false, error: '缺少 op' }); return; }
    try {
      const result = await dispatch(op, args);
      let payload = result;
      if (result && typeof result === 'object' && Buffer.isBuffer(result.buffer)) {
        payload = Object.assign({}, result);
        payload.buffer = '<binary ' + result.buffer.length + ' bytes>';
      }
      sendJson(res, 200, { ok: true, result: payload });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  async function handleImage(res, id, which) {
    try {
      const r = await dispatch('imageDataUrl', { id: id, which: which });
      if (!r.dataUrl) { sendJson(res, 404, { ok: false, error: '没有该图片: ' + which }); return; }
      const b64 = String(r.dataUrl).split(',')[1] || '';
      sendPng(res, Buffer.from(b64, 'base64'), { 'x-fdh-source': r.path || '' });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  async function handleRegion(res, url, id) {
    try {
      const q = url.searchParams;
      const args = { id: id, pad: q.get('pad') || 0 };
      if (q.get('ann')) args.annId = q.get('ann');
      else if (q.get('x') !== null) {
        args.rect = {
          x: Number(q.get('x')) || 0,
          y: Number(q.get('y')) || 0,
          w: Number(q.get('w')) || 1,
          h: Number(q.get('h')) || 1
        };
      }
      const r = await dispatch('regionCrop', args);
      if (!r || !r.buffer) { sendJson(res, 500, { ok: false, error: '裁剪失败' }); return; }
      sendPng(res, r.buffer, {
        'x-fdh-rect': JSON.stringify(r.rect),
        'x-fdh-image-size': r.imageWidth + 'x' + r.imageHeight
      });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  const server = http.createServer((req, res) => {
    const addr = req.socket && req.socket.remoteAddress;
    if (!isLoopback(addr)) { sendJson(res, 403, { ok: false, error: '仅允许本机回环访问' }); return; }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { sendJson(res, 400, { ok: false, error: 'bad url' }); return; }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        name: 'FrontDesignHelper',
        version: version,
        pid: process.pid,
        port: port,
        dataDir: P.dataDir(),
        startedAt: startedAt,
        tokenRequired: true
      });
      return;
    }

    const given = req.headers['x-fdh-token'] || url.searchParams.get('token') || '';
    if (given !== token) { sendJson(res, 401, { ok: false, error: 'token 无效' }); return; }

    if (url.pathname === '/api/rpc') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '请用 POST' }); return; }
      handleRpc(req, res).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
      return;
    }

    const imgMatch = /^\/api\/image\/([^/]+)\/(base|annotated)$/.exec(url.pathname);
    if (imgMatch) {
      handleImage(res, decodeURIComponent(imgMatch[1]), imgMatch[2]).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
      return;
    }

    const regMatch = /^\/api\/region\/([^/]+)$/.exec(url.pathname);
    if (regMatch) {
      handleRegion(res, url, decodeURIComponent(regMatch[1])).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
      return;
    }

    sendJson(res, 404, { ok: false, error: '未知路径: ' + url.pathname });
  });

  function writeRuntime() {
    const info = {
      name: 'FrontDesignHelper',
      version: version,
      pid: process.pid,
      port: port,
      token: token,
      dataDir: P.dataDir(),
      startedAt: startedAt
    };
    fs.writeFileSync(P.runtimeFile(), JSON.stringify(info, null, 2), 'utf8');
    return info;
  }

  function removeRuntime() {
    try {
      const p = P.runtimeFile();
      if (!fs.existsSync(p)) return;
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (cur && cur.pid && cur.pid !== process.pid) return;
      fs.unlinkSync(p);
    } catch (e) { /* ignore */ }
  }

  return new Promise((resolve, reject) => {
    server.on('error', (err) => reject(err));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = addr && addr.port;
      const info = writeRuntime();
      resolve({
        port: port,
        token: token,
        info: info,
        close: () => new Promise((res2) => {
          removeRuntime();
          try { server.close(() => res2()); } catch (e) { res2(); }
        })
      });
    });
  });
}

module.exports = { start, isLoopback };