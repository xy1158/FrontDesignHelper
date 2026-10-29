'use strict';
// 图片区域：画布渲染 + 框选/挪动/选择交互 + 叠加层导出
(function (NS) {
  const U = NS.util;
  const canvas = document.getElementById('canvas');
  const g2d = canvas.getContext('2d');

  const E = {
    img: null,
    imgW: 0,
    imgH: 0,
    sessionId: null,
    session: null,
    source: {},
    annotations: [],
    selectedId: null,
    tool: 'select',
    view: { scale: 1, ox: 0, oy: 0 },
    drag: null,
    pickup: null,
    spaceDown: false,
    showOverlay: true,
    history: [],
    future: [],
    cursor: { x: 0, y: 0, inside: false }
  };

  /* ------------------------------ 基础工具 ------------------------------ */

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function findAnn(id) {
    for (let i = 0; i < E.annotations.length; i++) if (E.annotations[i].id === id) return E.annotations[i];
    return null;
  }
  function annIndex(id) {
    for (let i = 0; i < E.annotations.length; i++) if (E.annotations[i].id === id) return i;
    return -1;
  }
  function insideRect(r, p) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }
  function sourceRect(a) {
    if (a.type === 'move') return a.from;
    return a.rect;
  }
  function targetRect(a) {
    return { x: a.to.x, y: a.to.y, w: a.from.w, h: a.from.h };
  }
  function stageSize() {
    return { w: canvas.clientWidth, h: canvas.clientHeight };
  }

  /* ------------------------------ 视图 ------------------------------ */

  function fit() {
    if (!E.img) return;
    const { w, h } = stageSize();
    const pad = 28;
    const s = Math.min((w - pad * 2) / E.imgW, (h - pad * 2) / E.imgH);
    E.view.scale = U.clamp(s, 0.02, 8);
    E.view.ox = Math.round((w - E.imgW * E.view.scale) / 2);
    E.view.oy = Math.round((h - E.imgH * E.view.scale) / 2);
    syncZoomLabel();
    draw();
  }

  function zoom100() {
    if (!E.img) return;
    const { w, h } = stageSize();
    E.view.scale = 1;
    E.view.ox = Math.round((w - E.imgW) / 2);
    E.view.oy = Math.round((h - E.imgH) / 2);
    syncZoomLabel();
    draw();
  }

  function zoomAt(factor, px, py) {
    if (!E.img) return;
    const s0 = E.view.scale;
    const s1 = U.clamp(s0 * factor, 0.05, 16);
    if (s1 === s0) return;
    E.view.ox = px - (px - E.view.ox) * (s1 / s0);
    E.view.oy = py - (py - E.view.oy) * (s1 / s0);
    E.view.scale = s1;
    syncZoomLabel();
    draw();
  }

  function centerOn(rect) {
    if (!E.img || !rect) return;
    const { w, h } = stageSize();
    const s = E.view.scale;
    E.view.ox = Math.round(w / 2 - (rect.x + rect.w / 2) * s);
    E.view.oy = Math.round(h / 2 - (rect.y + rect.h / 2) * s);
    draw();
  }

  function syncZoomLabel() {
    const el = document.getElementById('sb-zoom');
    if (el) el.textContent = Math.round(E.view.scale * 100) + '%';
  }

  /* ------------------------------ 绘制 ------------------------------ */

  function draw() {
    const { w, h } = stageSize();
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2d.clearRect(0, 0, w, h);
    if (!E.img) return;
    const s = E.view.scale;
    g2d.imageSmoothingEnabled = s < 2.5;
    g2d.drawImage(E.img, E.view.ox, E.view.oy, E.imgW * s, E.imgH * s);
    g2d.save();
    g2d.strokeStyle = 'rgba(120,150,190,.35)';
    g2d.lineWidth = 1;
    g2d.strokeRect(E.view.ox + 0.5, E.view.oy + 0.5, E.imgW * s, E.imgH * s);
    g2d.restore();
    if (E.showOverlay) {
      paintAnnotations(g2d, {
        s: s, ox: E.view.ox, oy: E.view.oy,
        lw: 1.8, fs: 11, interactive: true, showSnippet: false,
        maxX: w, maxY: h
      });
    }
    paintDrag(g2d);
  }

  function drawArrow(g, x1, y1, x2, y2, color, lw) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = lw;
    if (len > 2) {
      const ang = Math.atan2(dy, dx);
      const head = U.clamp(len * 0.35, 7, 16);
      const ax = x2 - Math.cos(ang) * head;
      const ay = y2 - Math.sin(ang) * head;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(ax, ay);
      g.stroke();
      g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(ax - Math.sin(ang) * head * 0.42, ay + Math.cos(ang) * head * 0.42);
      g.lineTo(ax + Math.sin(ang) * head * 0.42, ay - Math.cos(ang) * head * 0.42);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  function paintBadge(g, a, i, x, y, color, o) {
    const fs = o.fs;
    const label = String(i + 1);
    g.save();
    g.font = '700 ' + fs + 'px "Segoe UI","Microsoft YaHei UI",sans-serif';
    const tw = g.measureText(label).width;
    const bw = Math.max(fs + 8, tw + 10);
    const bh = fs + 8;
    let bx = x;
    let by = y - bh - 3;
    if (by < 0) by = y + 3;
    U.roundRect(g, bx, by, bw, bh, 4);
    g.fillStyle = color;
    g.fill();
    g.fillStyle = '#0a1119';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);

    if (o.showSnippet && a.prompt) {
      const text = String(a.prompt).replace(/\s+/g, ' ').slice(0, 34);
      g.font = '600 ' + fs + 'px "Segoe UI","Microsoft YaHei UI",sans-serif';
      const tw2 = g.measureText(text).width;
      const padx = 5;
      let sx = bx + bw + 4;
      if (sx + tw2 + padx * 2 > o.maxX) sx = Math.max(2, o.maxX - tw2 - padx * 2 - 2);
      U.roundRect(g, sx, by, tw2 + padx * 2, bh, 4);
      g.fillStyle = 'rgba(8,13,20,.82)';
      g.fill();
      g.strokeStyle = U.hexA(color, 0.7);
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = '#e8f1ff';
      g.textAlign = 'left';
      g.fillText(text, sx + padx, by + bh / 2 + 0.5);
    }
    g.restore();
  }

  function paintHandles(g, r, color, lw) {
    const pts = handlePoints(r);
    g.save();
    g.lineWidth = lw;
    for (const k in pts) {
      const p = pts[k];
      g.beginPath();
      g.rect(p.x - 3.5, p.y - 3.5, 7, 7);
      g.fillStyle = '#ffffff';
      g.fill();
      g.strokeStyle = color;
      g.stroke();
    }
    g.restore();
  }

  function handlePoints(r) {
    return {
      nw: { x: r.x, y: r.y },
      n: { x: r.x + r.w / 2, y: r.y },
      ne: { x: r.x + r.w, y: r.y },
      e: { x: r.x + r.w, y: r.y + r.h / 2 },
      se: { x: r.x + r.w, y: r.y + r.h },
      s: { x: r.x + r.w / 2, y: r.y + r.h },
      sw: { x: r.x, y: r.y + r.h },
      w: { x: r.x, y: r.y + r.h / 2 }
    };
  }

  function paintAnnotations(g, o) {
    const S = o.s, OX = o.ox, OY = o.oy;
    function px(r) { return { x: r.x * S + OX, y: r.y * S + OY, w: r.w * S, h: r.h * S }; }
    for (let i = 0; i < E.annotations.length; i++) {
      const a = E.annotations[i];
      const color = a.color || '#ff5d5d';
      const sel = o.interactive && a.id === E.selectedId;
      if (a.type === 'move') {
        const fr = px(a.from);
        const tr = px(targetRect(a));
        g.save();
        g.globalAlpha = 0.9;
        try {
          g.drawImage(E.img, a.from.x, a.from.y, a.from.w, a.from.h, tr.x, tr.y, tr.w, tr.h);
        } catch (e) { /* 越界时忽略 */ }
        g.restore();
        g.save();
        g.strokeStyle = color;
        g.globalAlpha = 0.55;
        g.lineWidth = o.lw;
        g.setLineDash([5, 4]);
        g.strokeRect(fr.x, fr.y, fr.w, fr.h);
        g.restore();
        g.save();
        g.strokeStyle = color;
        g.lineWidth = o.lw;
        g.setLineDash([]);
        g.strokeRect(tr.x, tr.y, tr.w, tr.h);
        g.restore();
        drawArrow(g, fr.x + fr.w / 2, fr.y + fr.h / 2, tr.x + tr.w / 2, tr.y + tr.h / 2, color, o.lw);
        paintBadge(g, a, i, fr.x, fr.y, color, o);
        if (sel && o.interactive) {
          paintHandles(g, fr, color, o.lw);
          g.save();
          g.beginPath();
          g.arc(tr.x + tr.w / 2, tr.y + tr.h / 2, 5, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
          g.strokeStyle = '#fff';
          g.lineWidth = 1.5;
          g.stroke();
          g.restore();
        }
      } else {
        const r = px(a.rect);
        g.save();
        g.fillStyle = U.hexA(color, 0.12);
        g.fillRect(r.x, r.y, r.w, r.h);
        g.strokeStyle = color;
        g.lineWidth = o.lw;
        g.strokeRect(r.x, r.y, r.w, r.h);
        g.restore();
        paintBadge(g, a, i, r.x, r.y, color, o);
        if (sel && o.interactive) paintHandles(g, r, color, o.lw);
      }
    }
  }

  function paintDrag(g) {
    if (E.drag && E.drag.mode === 'new') {
      const r = E.drag.rect;
      const s = E.view.scale;
      const sr = { x: r.x * s + E.view.ox, y: r.y * s + E.view.oy, w: r.w * s, h: r.h * s };
      g.save();
      g.setLineDash([6, 4]);
      g.strokeStyle = E.drag.kind === 'move' ? '#ffb020' : '#4f9dff';
      g.lineWidth = 1.6;
      g.fillStyle = E.drag.kind === 'move' ? 'rgba(255,176,32,.1)' : 'rgba(79,157,255,.1)';
      g.fillRect(sr.x, sr.y, sr.w, sr.h);
      g.strokeRect(sr.x, sr.y, sr.w, sr.h);
      g.setLineDash([]);
      g.font = '600 11px "Cascadia Mono",Consolas,monospace';
      g.fillStyle = '#dbe8fb';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText(Math.round(r.w) + ' × ' + Math.round(r.h), sr.x + 3, sr.y - 4);
      g.restore();
    }
    if (E.pickup) {
      const s = E.view.scale;
      const cur = E.cursor;
      const tr = {
        x: (cur.x - E.pickup.offset.x) * s + E.view.ox,
        y: (cur.y - E.pickup.offset.y) * s + E.view.oy,
        w: E.pickup.from.w * s,
        h: E.pickup.from.h * s
      };
      const fr = {
        x: E.pickup.from.x * s + E.view.ox,
        y: E.pickup.from.y * s + E.view.oy,
        w: E.pickup.from.w * s,
        h: E.pickup.from.h * s
      };
      g.save();
      g.globalAlpha = 0.8;
      g.drawImage(E.img, E.pickup.from.x, E.pickup.from.y, E.pickup.from.w, E.pickup.from.h, tr.x, tr.y, tr.w, tr.h);
      g.restore();
      g.save();
      g.strokeStyle = '#ffb020';
      g.lineWidth = 1.8;
      g.strokeRect(tr.x, tr.y, tr.w, tr.h);
      g.globalAlpha = 0.5;
      g.setLineDash([5, 4]);
      g.strokeRect(fr.x, fr.y, fr.w, fr.h);
      g.restore();
    }
  }

  // 导出叠加图（给 AI 看的「意图结果图」）
  function annotatedDataUrl() {
    if (!E.img) return null;
    const c = document.createElement('canvas');
    c.width = E.imgW;
    c.height = E.imgH;
    const g = c.getContext('2d');
    g.drawImage(E.img, 0, 0);
    const lw = Math.max(1.6, E.imgW / 900);
    const fs = Math.max(11, Math.round(E.imgW / 95));
    paintAnnotations(g, {
      s: 1, ox: 0, oy: 0, lw: lw, fs: fs,
      interactive: false, showSnippet: true, maxX: E.imgW, maxY: E.imgH
    });
    return c.toDataURL('image/png');
  }

  /* ------------------------------ 交互 ------------------------------ */

  function imgPoint(e) {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    return { x: (px - E.view.ox) / E.view.scale, y: (py - E.view.oy) / E.view.scale, px: px, py: py };
  }

  function hitTest(p) {
    for (let i = E.annotations.length - 1; i >= 0; i--) {
      const a = E.annotations[i];
      if (a.type === 'move') {
        if (insideRect(a.from, p)) return { id: a.id, part: 'source' };
        if (insideRect(targetRect(a), p)) return { id: a.id, part: 'target' };
      } else if (insideRect(a.rect, p)) {
        if (a.id === E.selectedId) {
          const s = E.view.scale;
          const sr = {
            x: a.rect.x * s + E.view.ox, y: a.rect.y * s + E.view.oy,
            w: a.rect.w * s, h: a.rect.h * s
          };
          const pts = handlePoints(sr);
          for (const k in pts) {
            if (Math.abs(p.px - pts[k].x) <= 7 && Math.abs(p.py - pts[k].y) <= 7) {
              return { id: a.id, part: 'handle', handle: k };
            }
          }
        }
        return { id: a.id, part: 'body' };
      } else if (a.id === E.selectedId) {
        const s = E.view.scale;
        const sr = { x: a.rect.x * s + E.view.ox, y: a.rect.y * s + E.view.oy, w: a.rect.w * s, h: a.rect.h * s };
        const pts = handlePoints(sr);
        for (const k in pts) {
          if (Math.abs(p.px - pts[k].x) <= 7 && Math.abs(p.py - pts[k].y) <= 7) {
            return { id: a.id, part: 'handle', handle: k };
          }
        }
      }
    }
    return null;
  }

  function pushUndo() {
    E.history.push({ annotations: clone(E.annotations), selectedId: E.selectedId });
    if (E.history.length > 60) E.history.shift();
    E.future.length = 0;
  }

  function undo() {
    if (!E.history.length) { U.toast('没有可撤销的操作', 'warn', 1400); return; }
    E.future.push({ annotations: clone(E.annotations), selectedId: E.selectedId });
    const snap = E.history.pop();
    E.annotations = snap.annotations;
    E.selectedId = snap.selectedId && findAnn(snap.selectedId) ? snap.selectedId : null;
    draw();
    NS.app.touch();
    NS.app.selectionChanged();
  }

  function select(id) {
    const changed = E.selectedId !== id;
    E.selectedId = id;
    draw();
    if (changed) NS.app.selectionChanged();
  }

  function deleteSelected() {
    const id = E.selectedId;
    if (!id) return;
    pushUndo();
    E.annotations = E.annotations.filter(function (a) { return a.id !== id; });
    E.selectedId = null;
    draw();
    NS.app.touch();
    NS.app.selectionChanged();
  }

  function setTool(tool) {
    if (['select', 'box', 'move'].indexOf(tool) < 0) return;
    if (E.pickup) { E.pickup = null; }
    E.tool = tool;
    canvas.classList.remove('tool-box', 'tool-move');
    if (tool === 'box') canvas.classList.add('tool-box');
    if (tool === 'move') canvas.classList.add('tool-move');
    const map = { select: '选择', box: '框选', move: '挪动' };
    const sb = document.getElementById('sb-tool');
    if (sb) sb.textContent = '工具：' + map[tool];
    U.$$('.toolbtn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    setHintForTool();
    draw();
  }

  function setHint(text) {
    const el = document.getElementById('hint');
    if (!el) return;
    if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = text;
    el.classList.remove('hidden');
  }

  function setHintForTool() {
    if (E.pickup) { setHint('松开后移动鼠标放置区块，单击确认 · Esc 取消'); return; }
    if (E.tool === 'box') { setHint('拖拽框出问题区域 · 松开后右侧自动生成提示词条目'); return; }
    if (E.tool === 'move') { setHint('拖拽选中要挪动的区块 · 松开后再单击放置到目标位置'); return; }
    if (E.spaceDown) { setHint('按住空格拖动可平移画布'); return; }
    setHint('');
  }

  function onPointerDown(e) {
    if (e.button === 2) return;
    if (e.button === 1 || (e.button === 0 && E.spaceDown)) {
      e.preventDefault();
      E.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: E.view.ox, oy: E.view.oy };
      canvas.classList.add('panning');
      return;
    }
    if (!E.img) return;
    const p = imgPoint(e);
    E.cursor = { x: p.x, y: p.y, inside: true };

    if (E.pickup) { commitPickup(p); return; }

    if (E.tool === 'box' || E.tool === 'move') {
      E.drag = {
        mode: 'new',
        kind: E.tool,
        start: { x: p.x, y: p.y },
        rect: { x: p.x, y: p.y, w: 0, h: 0 }
      };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件没有真实指针 */ }
      draw();
      return;
    }

    const hit = hitTest(p);
    if (hit) {
      if (E.selectedId !== hit.id) select(hit.id);
      const a = findAnn(hit.id);
      if (!a) return;
      if (hit.part === 'handle') {
        pushUndo();
        E.drag = { mode: 'resize', id: a.id, handle: hit.handle, orig: clone(a), start: { x: p.x, y: p.y } };
      } else if (hit.part === 'target') {
        pushUndo();
        E.drag = { mode: 'target', id: a.id, orig: clone(a), start: { x: p.x, y: p.y } };
      } else {
        pushUndo();
        E.drag = { mode: 'body', id: a.id, orig: clone(a), start: { x: p.x, y: p.y } };
      }
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件没有真实指针 */ }
      return;
    }
    select(null);
    E.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: E.view.ox, oy: E.view.oy };
    canvas.classList.add('panning');
  }

  function onPointerMove(e) {
    if (!E.img) return;
    const p = imgPoint(e);
    E.cursor = { x: p.x, y: p.y, inside: p.px >= 0 && p.py >= 0 && p.px <= canvas.clientWidth && p.py <= canvas.clientHeight };
    const c = document.getElementById('sb-coords');
    if (c) c.textContent = 'x=' + Math.round(p.x) + ' y=' + Math.round(p.y);

    const d = E.drag;
    if (d) {
      if (d.mode === 'pan') {
        E.view.ox = d.ox + (e.clientX - d.sx);
        E.view.oy = d.oy + (e.clientY - d.sy);
      } else if (d.mode === 'new') {
        d.rect = {
          x: Math.min(d.start.x, p.x),
          y: Math.min(d.start.y, p.y),
          w: Math.abs(p.x - d.start.x),
          h: Math.abs(p.y - d.start.y)
        };
      } else if (d.mode === 'body') {
        const a = findAnn(d.id);
        if (a) {
          const dx = Math.round(p.x - d.start.x);
          const dy = Math.round(p.y - d.start.y);
          if (a.type === 'move') {
            a.from.x = Math.round(d.orig.from.x + dx);
            a.from.y = Math.round(d.orig.from.y + dy);
            a.to.x = Math.round(d.orig.to.x + dx);
            a.to.y = Math.round(d.orig.to.y + dy);
          } else {
            a.rect.x = Math.round(d.orig.rect.x + dx);
            a.rect.y = Math.round(d.orig.rect.y + dy);
          }
        }
      } else if (d.mode === 'target') {
        const a = findAnn(d.id);
        if (a && a.type === 'move') {
          a.to.x = Math.round(d.orig.to.x + (p.x - d.start.x));
          a.to.y = Math.round(d.orig.to.y + (p.y - d.start.y));
        }
      } else if (d.mode === 'resize') {
        const a = findAnn(d.id);
        if (a) {
          const o = d.orig;
          const r = a.type === 'move' ? o.from : o.rect;
          let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
          const hx = p.x, hy = p.y;
          if (d.handle.indexOf('w') >= 0) x1 = hx;
          if (d.handle.indexOf('e') >= 0) x2 = hx;
          if (d.handle.indexOf('n') >= 0) y1 = hy;
          if (d.handle.indexOf('s') >= 0) y2 = hy;
          const nr = {
            x: Math.round(Math.min(x1, x2)),
            y: Math.round(Math.min(y1, y2)),
            w: Math.max(4, Math.round(Math.abs(x2 - x1))),
            h: Math.max(4, Math.round(Math.abs(y2 - y1)))
          };
          if (a.type === 'move') { a.from = nr; } else { a.rect = nr; }
        }
      }
      draw();
      if (d.mode !== 'pan') NS.app.peekCoords(E.selectedId);
      return;
    }
    if (E.pickup) { draw(); return; }
    draw();
  }

  function onPointerUp(e) {
    const d = E.drag;
    canvas.classList.remove('panning');
    if (!d) return;
    E.drag = null;
    if (d.mode === 'new') {
      const r = { x: Math.round(d.rect.x), y: Math.round(d.rect.y), w: Math.round(d.rect.w), h: Math.round(d.rect.h) };
      if (r.w < 5 || r.h < 5) { draw(); return; }
      if (d.kind === 'box') {
        pushUndo();
        const ann = {
          id: U.uid('ann'), type: 'box', rect: r, prompt: '',
          color: U.pickColor(E.annotations), status: 'pending', aiNote: ''
        };
        E.annotations.push(ann);
        E.selectedId = ann.id;
        NS.app.touch();
        NS.app.selectionChanged();
        NS.app.focusCard(ann.id);
        setTool('select');
        U.toast('已生成第 ' + E.annotations.length + ' 条提示词条目，请在右侧填写', 'ok', 2200);
      } else {
        const p = imgPoint(e);
        E.pickup = {
          from: r,
          offset: { x: p.x - r.x, y: p.y - r.y },
          color: U.pickColor(E.annotations)
        };
        setHintForTool();
      }
    } else if (d.mode === 'body' || d.mode === 'target' || d.mode === 'resize') {
      NS.app.touch();
      NS.app.selectionChanged();
    }
    draw();
    if (!E.pickup) setHintForTool();
  }

  function commitPickup(p) {
    const pk = E.pickup;
    E.pickup = null;
    const to = { x: Math.round(p.x - pk.offset.x), y: Math.round(p.y - pk.offset.y) };
    if (Math.abs(to.x - pk.from.x) < 3 && Math.abs(to.y - pk.from.y) < 3) {
      U.toast('没有产生位移，已取消本次挪动', 'warn', 1800);
      setToolForAfter();
      draw();
      return;
    }
    pushUndo();
    const ann = {
      id: U.uid('ann'), type: 'move', from: pk.from, to: to, prompt: '',
      color: pk.color, status: 'pending', aiNote: ''
    };
    E.annotations.push(ann);
    E.selectedId = ann.id;
    NS.app.touch();
    NS.app.selectionChanged();
    NS.app.focusCard(ann.id);
    U.toast('已记录挪动：dx=' + (to.x - pk.from.x) + ' dy=' + (to.y - pk.from.y), 'ok', 2400);
    setTool('select');
    draw();
  }

  function setToolForAfter() {
    setHintForTool();
    draw();
  }

  function nudge(dx, dy) {
    const a = findAnn(E.selectedId);
    if (!a) return;
    pushUndo();
    if (a.type === 'move') {
      a.from.x += dx; a.from.y += dy;
      a.to.x += dx; a.to.y += dy;
    } else {
      a.rect.x += dx; a.rect.y += dy;
    }
    draw();
    NS.app.touch();
    NS.app.peekCoords(E.selectedId);
  }

  /* ------------------------------ 会话 ------------------------------ */

  function reset() {
    E.img = null; E.imgW = 0; E.imgH = 0;
    E.sessionId = null; E.session = null; E.source = {};
    E.annotations = []; E.selectedId = null;
    E.history = []; E.future = [];
    E.pickup = null; E.drag = null;
    draw();
  }

  function loadImageFromDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      const im = new Image();
      im.onload = function () {
        E.img = im;
        E.imgW = im.naturalWidth;
        E.imgH = im.naturalHeight;
        resolve(im);
      };
      im.onerror = function () { reject(new Error('原图解码失败')); };
      im.src = dataUrl;
    });
  }

  async function loadSession(id) {
    // 先清空图像状态：切换过程中 imageLoaded 必须如实反映「这张图还没到」
    E.img = null;
    E.imgW = 0;
    E.imgH = 0;
    const data = await U.api('getSession', { id: id });
    E.sessionId = id;
    E.session = data.session;
    E.source = data.source || {};
    E.annotations = (data.annotations || []).map(clone);
    E.selectedId = null;
    E.history = []; E.future = [];
    const img = await U.api('imageDataUrl', { id: id, which: 'base' });
    if (!img || !img.dataUrl) throw new Error('该会话缺少原图');
    await loadImageFromDataUrl(img.dataUrl);
    document.getElementById('empty').classList.add('hidden');
    fit();
    NS.app.onSessionLoaded(data);
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', function () { E.drag = null; draw(); });
  canvas.addEventListener('pointerleave', function () {
    if (!E.drag) {
      const c = document.getElementById('sb-coords');
      if (c) c.textContent = 'x=– y=–';
    }
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('wheel', function (e) {
    if (!E.img) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(factor, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  window.addEventListener('resize', function () { draw(); });
  window.addEventListener('keydown', function (e) {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (e.code === 'Space' && !typing) {
      if (!E.spaceDown) { E.spaceDown = true; setHintForTool(); }
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (E.pickup) { E.pickup = null; draw(); setToolForAfter(); return; }
      if (E.drag) { E.drag = null; draw(); return; }
      if (E.selectedId) { select(null); return; }
      setHint('');
      return;
    }
    if (typing) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    const k = e.key.toLowerCase();
    if (!e.ctrlKey && !e.metaKey) {
      if (k === 'v') { setTool('select'); return; }
      if (k === 'b') { setTool('box'); return; }
      if (k === 'm') { setTool('move'); return; }
      if (k === 'f') { fit(); return; }
      if (k === '1') { zoom100(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
      if (e.key.indexOf('Arrow') === 0) {
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft') nudge(-step, 0);
        if (e.key === 'ArrowRight') nudge(step, 0);
        if (e.key === 'ArrowUp') nudge(0, -step);
        if (e.key === 'ArrowDown') nudge(0, step);
        e.preventDefault();
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      if (e.shiftKey) NS.app.redo(); else undo();
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 's') {
      e.preventDefault();
      NS.app.forceSave();
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { E.spaceDown = false; setHintForTool(); }
  });

  NS.editor = {
    state: E,
    draw: draw,
    fit: fit,
    zoom100: zoom100,
    zoomAt: zoomAt,
    centerOn: centerOn,
    select: select,
    setTool: setTool,
    setHint: setHint,
    deleteSelected: deleteSelected,
    undo: undo,
    pushUndo: pushUndo,
    findAnn: findAnn,
    annotatedDataUrl: annotatedDataUrl,
    loadSession: loadSession,
    reset: reset,
    nudge: nudge,
    setOverlay: function (v) { E.showOverlay = !!v; draw(); },
    redo: function () {
      if (!E.future.length) { U.toast('没有可重做的操作', 'warn', 1400); return; }
      E.history.push({ annotations: clone(E.annotations), selectedId: E.selectedId });
      const snap = E.future.pop();
      E.annotations = snap.annotations;
      E.selectedId = snap.selectedId && findAnn(snap.selectedId) ? snap.selectedId : null;
      draw();
      NS.app.touch();
      NS.app.selectionChanged();
    }
  };
})(window.FDH);