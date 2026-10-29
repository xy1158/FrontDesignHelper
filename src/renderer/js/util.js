'use strict';
// 渲染进程公共工具
window.FDH = window.FDH || {};
(function (NS) {
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function round(v) { return Math.round(v); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  function debounce(fn, ms) {
    let t = null;
    const wrapped = function () {
      const args = arguments;
      const self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
    wrapped.cancel = function () { if (t) { clearTimeout(t); t = null; } };
    wrapped.flush = function () { if (t) { clearTimeout(t); t = null; fn(); } };
    return wrapped;
  }
  function hexA(hex, alpha) {
    let h = String(hex || '#4f9dff').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (!isFinite(n)) return 'rgba(79,157,255,' + alpha + ')';
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  function roundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.lineTo(x + w - rr, y);
    g.quadraticCurveTo(x + w, y, x + w, y + rr);
    g.lineTo(x + w, y + h - rr);
    g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    g.lineTo(x + rr, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - rr);
    g.lineTo(x, y + rr);
    g.quadraticCurveTo(x, y, x + rr, y);
    g.closePath();
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (!isFinite(d.getTime())) return String(iso || '');
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function toast(msg, kind, ms) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = String(msg == null ? '' : msg);
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, ms || 2600);
  }
  async function api(op, args) {
    if (!window.fdh) throw new Error('预加载桥未就绪');
    const r = await window.fdh.api(op, args || {});
    if (!r || !r.ok) throw new Error((r && r.error) || ('调用 ' + op + ' 失败'));
    return r.result;
  }
  async function copyText(text) {
    if (window.fdh && window.fdh.copyText) {
      const r = await window.fdh.copyText(text);
      if (!r || !r.ok) throw new Error('复制失败');
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  }
  const PALETTE = ['#ff5d5d', '#4f9dff', '#3ddc97', '#ffb020', '#b07bff', '#ff7ad9', '#2ee6d6', '#ffd93d'];
  function pickColor(list) { return PALETTE[(list ? list.length : 0) % PALETTE.length]; }

  NS.util = {
    $: $, $$: $$, clamp: clamp, round: round, esc: esc, uid: uid, debounce: debounce,
    hexA: hexA, roundRect: roundRect, fmtTime: fmtTime, toast: toast, api: api,
    copyText: copyText, PALETTE: PALETTE, pickColor: pickColor
  };
})(window.FDH);