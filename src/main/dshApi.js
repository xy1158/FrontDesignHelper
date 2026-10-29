'use strict';
// 通过 DSH web 宿主的正式 RPC 把任务投进指定对话（不模拟按键、不切换窗口）。
//
// 传输：POST http://127.0.0.1:<port>/api/<namespace>/<method>
//       body { type:'client-request', rpcId, method, payload:{ args:{...} } }
// 鉴权：cookie 名 = dsh-auth-<b64url(sha256(authority))>，值 = v1.<b64url(payload)>.<b64url(hmacSha256(secret,payload))>
//       secret 来自 ~/.dsh/.credentials.yaml 的 client-connection/browser-session 记录（32 字节，base64url）
// 端点：session/create、session/prompt、session/list（参数名分别为 request / request / _request）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const CANDIDATE_PORTS = [3080, 3000, 3001, 8080, 8888, 4000, 5000];
let cachedPort = 0;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}

// 宽松解析 credentials.yaml：取 records 里第一个 secret（client-connection/browser-session）
function readBrowserSecret() {
  const file = path.join(dshHome(), '.credentials.yaml');
  if (!fs.existsSync(file)) throw new Error('找不到 ' + file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let inRecords = false;
  for (const line of lines) {
    if (/^records:\s*$/.test(line)) { inRecords = true; continue; }
    if (!inRecords) continue;
    if (/^\S/.test(line)) break;
    const m = /secret:\s*([A-Za-z0-9_-]+)/.exec(line);
    if (m) {
      const raw = unb64url(m[1]);
      if (raw.byteLength === 32) return raw;
    }
  }
  throw new Error('credentials 里没有可用的 browser-session secret');
}

function cookieHeader(port) {
  const authority = '127.0.0.1:' + port;
  const secret = readBrowserSecret();
  const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest());
  const now = Date.now();
  const payload = { version: 1, authority: authority, issuedAt: now, expiresAt: now + 6 * 3600 * 1000 };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return name + '=v1.' + body + '.' + sig;
}

function rawCall(port, endpoint, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let body;
    try {
      body = Buffer.from(JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: endpoint,
        payload: { args: args || {} }
      }), 'utf8');
    } catch (e) { reject(e); return; }
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: '/api/' + endpoint,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        cookie: cookieHeader(port),
        origin: 'http://127.0.0.1:' + port,
        'sec-fetch-site': 'same-origin'
      },
      timeout: timeoutMs || 20000
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) { reject(new Error('DSH 拒绝了本地凭证（cookie 无效），可能已被吊销')); return; }
        if (res.statusCode === 403) { reject(new Error('DSH 拒绝了请求来源（Host/Origin 校验）')); return; }
        let data;
        try { data = JSON.parse(text); } catch (e) { reject(new Error('DSH 返回非 JSON（HTTP ' + res.statusCode + '）')); return; }
        if (!data || data.type !== 'server-response' || !data.result) { reject(new Error('DSH 返回格式异常')); return; }
        if (data.result.ok === true) { resolve(data.result.value); return; }
        const err = data.result.error || {};
        reject(new Error('DSH 调用失败 ' + (err.code || '') + ': ' + (err.message || '')));
      });
    });
    req.on('timeout', function () { req.destroy(new Error('连接 DSH 超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function call(endpoint, args, portHint) {
  const ports = [];
  if (portHint) ports.push(Number(portHint));
  if (cachedPort && ports.indexOf(cachedPort) < 0) ports.push(cachedPort);
  CANDIDATE_PORTS.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); });

  let lastErr = null;
  for (const port of ports) {
    try {
      const value = await rawCall(port, endpoint, args);
      cachedPort = port;
      return { port: port, value: value };
    } catch (e) {
      lastErr = e;
      if (/cookie|凭证|403/.test(e.message)) break; // 鉴权/来源类错误，换端口也没用
    }
  }
  throw lastErr || new Error('无法连接 DSH web 宿主');
}

/* ------------------------------ 对外 API ------------------------------ */

// 探测可用的 DSH web 端口（顺带验证凭证）
async function ping(portHint) {
  const r = await call('session/list', { _request: {} }, portHint);
  return { port: r.port, sessions: (r.value && r.value.items) || [] };
}

// 新建会话（返回 sessionId）。cwd 决定它挂在哪个工作区下。
async function createSession(cwd, portHint) {
  const r = await call('session/create', { request: { cwd: cwd || undefined } }, portHint);
  return { port: r.port, sessionId: r.value.sessionId };
}

// 向既有会话投递一条用户消息，DSH 会立刻开始这一轮工作
async function promptSession(sessionId, text, portHint) {
  const r = await call('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: String(text) }]
    }
  }, portHint);
  return { port: r.port, sessionId: sessionId, accepted: !!(r.value && r.value.accepted) };
}

module.exports = { ping, createSession, promptSession, readBrowserSecret, dshHome };