'use strict';
// 提示词区域：标注卡片、会话信息、工具栏、模态框、保存与轮询
(function (NS) {
  const U = NS.util;
  let ed = null;
  let busy = false;
  let windowsCache = [];
  let pollTimer = null;
  let lastSeen = { id: null, statuses: '' };
  let lastExportError = '';
  // 会话返回栈：AI 请求新截图会切走当前会话，用这个栈回到上一条
  const sessionStack = [];
  // 每个 AI 请求的会话只自动切换一次；否则轮询会把用户手动切走的视图反复拽回来
  const autoSwitched = new Set();
  let aiRunning = false;
  let aiWorkspaces = [];
  let aiConversations = [];
  let aiWorkspace = '';
  let aiMode = 'api';
  let aiWindowTitle = 'DeepSeek Harness';
  let aiAutoPaste = true;
  let lastDispatchedSession = '';
  let aiContinueFrom = '';
  // 本地正在编辑的标注：这些不会被磁盘内容覆盖，避免打断输入
  const dirtyIds = new Set();

  function statusLabel(st) {
    if (st === 'done') return '已完成';
    if (st === 'skipped') return '已跳过';
    return '待处理';
  }

  function setSaveState(text, cls) {
    const el = document.getElementById('save-state');
    if (!el) return;
    el.textContent = text;
    el.className = 'save-state' + (cls ? ' ' + cls : '');
  }

  /* ------------------------------ 保存 ------------------------------ */

  async function doSave() {
    const st = ed.state;
    if (!st.sessionId) return;
    const id = st.sessionId;
    setSaveState('保存中…', 'saving');
    try {
      const r = await U.api('saveAnnotations', { id: id, annotations: st.annotations });
      const byId = {};
      (r.annotations || []).forEach(function (a) { byId[a.id] = a; });
      st.annotations.forEach(function (a) {
        const d = byId[a.id];
        if (d) { a.status = d.status; a.aiNote = d.aiNote; }
      });
      st.session = r.session;
      dirtyIds.clear();
      setSaveState('已保存 · ' + U.fmtTime(new Date().toISOString()).slice(11), 'saved');
      renderMeta();
      syncCardMeta();
      exportDebounced();
      lastSeen.statuses = statusKey();
    } catch (e) {
      setSaveState('保存失败', 'err');
      U.toast('保存失败：' + e.message, 'err', 4500);
    }
  }

  // 切会话前必须把当前编辑落盘，否则最后不到 420ms 的输入会丢
  async function forceSaveNow() {
    saveDebounced.cancel();
    if (!ed.state.sessionId) return;
    try { await doSave(); } catch (e) { /* doSave 内部已有提示 */ }
  }

  function updateBackButton() {
    const b = document.getElementById('btn-back');
    if (b) b.disabled = sessionStack.length === 0;
  }

  async function switchSession(id, note) {
    if (!id || id === ed.state.sessionId) return false;
    await forceSaveNow();
    const prev = ed.state.sessionId;
    await ed.loadSession(id);
    if (prev) sessionStack.push(prev);
    updateBackButton();
    refreshSessionSelect(true);
    if (note) U.toast(note, '', 3400);
    return true;
  }

  async function goBackSession() {
    const prev = sessionStack.pop();
    updateBackButton();
    if (!prev) return;
    await forceSaveNow();
    await ed.loadSession(prev);
    refreshSessionSelect(true);
    U.toast('已回到上一个会话', '', 1800);
  }

  let selectSig = '';
  async function refreshSessionSelect(force) {
    const sel = document.getElementById('session-select');
    if (!sel) return;
    try {
      const r = await U.api('listSessions');
      const list = r.sessions || [];
      const sig = list.map(function (s) { return s.id + ':' + s.annotationCount + ':' + s.updatedAt; }).join('|') + '#' + ed.state.sessionId;
      if (!force && sig === selectSig) return;
      selectSig = sig;
      sel.innerHTML = '';
      list.slice(0, 30).forEach(function (s) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = U.fmtTime(s.createdAt).slice(5) + ' · ' + (s.annotationCount ? s.annotationCount + '条' : '空') + ' · ' + String(s.source.title || '').slice(0, 20);
        if (s.id === ed.state.sessionId) o.selected = true;
        sel.appendChild(o);
      });
      if (ed.state.sessionId) sel.value = ed.state.sessionId;
    } catch (e) { /* 下拉刷新失败不影响主流程 */ }
  }

  function statusKey() {
    return ed.state.annotations.map(function (a) { return a.id + ':' + (a.status || '') + ':' + (a.aiNote || ''); }).join('|');
  }

  async function doExport() {
    const st = ed.state;
    if (!st.sessionId || !st.img) return;
    try {
      const dataUrl = ed.annotatedDataUrl();
      if (!dataUrl) return;
      await U.api('saveAnnotated', { id: st.sessionId, dataUrl: dataUrl });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (lastExportError !== msg) {
        lastExportError = msg;
        U.toast('叠加图导出失败：' + msg, 'err', 5000);
      }
    }
  }

  const saveDebounced = U.debounce(doSave, 420);
  const exportDebounced = U.debounce(doExport, 1200);

  /* ------------------------------ 卡片 ------------------------------ */

  function posText(a) {
    if (a.type === 'move') {
      return '从 ' + a.from.x + ',' + a.from.y + ' → ' + a.to.x + ',' + a.to.y + ' · ' + a.from.w + '×' + a.from.h;
    }
    return a.rect.x + ',' + a.rect.y + ' · ' + a.rect.w + '×' + a.rect.h;
  }

  function cardEl(a, i) {
    const sel = a.id === ed.state.selectedId;
    const el = document.createElement('div');
    el.className = 'card' + (sel ? ' sel' : '') + (a.status === 'done' ? ' done' : '');
    el.dataset.id = a.id;
    el.innerHTML =
      '<div class="card-head">' +
        '<span class="idx" style="background:' + U.esc(a.color || '#ff5d5d') + '">' + (i + 1) + '</span>' +
        '<span class="badge">' + (a.type === 'move' ? '挪动' : '框选') + '</span>' +
        '<span class="pos">' + U.esc(posText(a)) + '</span>' +
        '<button class="del" title="删除这条标注">✕</button>' +
      '</div>' +
      '<textarea class="prompt" rows="2" placeholder="' +
        (a.type === 'move' ? '说明这个区块要挪到哪里、为什么：例如「标题栏挪到顶部居中」' : '说明这里要改成什么样：例如「这个按钮改为蓝色主色调、圆角 8px、宽度 240」') +
      '"></textarea>' +
      '<div class="card-foot">' +
        '<span class="status' + statusCls(a.status) + '">' + statusLabel(a.status) + '</span>' +
        '<span class="note" title="' + U.esc(a.aiNote || '') + '">' + U.esc(a.aiNote || '') + '</span>' +
        '<button class="locate" title="在图片中定位">定位</button>' +
      '</div>';

    const ta = el.querySelector('.prompt');
    ta.value = a.prompt || '';
    ta.addEventListener('input', function () {
      a.prompt = ta.value;
      dirtyIds.add(a.id);
      NS.app.touch();
    });
    ta.addEventListener('focus', function () {
      if (ed.state.selectedId !== a.id) ed.select(a.id);
    });
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        NS.app.forceSave();
        U.toast('已保存，现在可以让 AI 读取了', 'ok', 2200);
      }
    });
    el.addEventListener('mousedown', function (e) {
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (t && t.classList && t.classList.contains('del')) return;
      if (ed.state.selectedId !== a.id) ed.select(a.id);
    });
    el.querySelector('.del').addEventListener('click', function (e) {
      e.stopPropagation();
      removeAnn(a.id);
    });
    el.querySelector('.locate').addEventListener('click', function (e) {
      e.stopPropagation();
      ed.select(a.id);
      const r = a.type === 'move' ? a.from : a.rect;
      ed.centerOn(r);
    });
    return el;
  }

  function statusCls(st) {
    if (st === 'done') return ' st-done';
    if (st === 'skipped') return ' st-skipped';
    return '';
  }

  function renderCards() {
    const host = document.getElementById('cards');
    const noCards = document.getElementById('no-cards');
    const list = ed.state.annotations;
    host.innerHTML = '';
    if (!list.length) {
      noCards.classList.remove('hidden');
      host.classList.add('hidden');
    } else {
      noCards.classList.add('hidden');
      host.classList.remove('hidden');
      list.forEach(function (a, i) { host.appendChild(cardEl(a, i)); });
    }
    renderMeta();
  }

  function syncSelection() {
    const host = document.getElementById('cards');
    const id = ed.state.selectedId;
    U.$$('.card', host).forEach(function (el) {
      el.classList.toggle('sel', el.dataset.id === id);
    });
    if (id) {
      const el = host.querySelector('.card[data-id="' + id + '"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function syncCardMeta() {
    const host = document.getElementById('cards');
    ed.state.annotations.forEach(function (a) {
      const el = host.querySelector('.card[data-id="' + a.id + '"]');
      if (!el) return;
      const st = el.querySelector('.status');
      if (st) {
        st.textContent = statusLabel(a.status);
        st.className = 'status' + statusCls(a.status);
      }
      const note = el.querySelector('.note');
      if (note) {
        note.textContent = a.aiNote || '';
        note.title = a.aiNote || '';
      }
      el.classList.toggle('done', a.status === 'done');
      const pos = el.querySelector('.pos');
      if (pos) pos.textContent = posText(a);
    });
    updateCounts();
  }

  function updateCounts() {
    const list = ed.state.annotations;
    let pending = 0, done = 0, skipped = 0;
    list.forEach(function (a) {
      if (a.status === 'done') done++;
      else if (a.status === 'skipped') skipped++;
      else pending++;
    });
    const pill = document.getElementById('pending-count');
    if (pill) pill.textContent = pending + ' 条待处理';
    const counts = document.getElementById('counts');
    if (counts) counts.textContent = '共 ' + list.length + ' 条 · 待 ' + pending + ' / 完成 ' + done + (skipped ? ' / 跳过 ' + skipped : '');
  }

  function renderMeta() {
    const meta = document.getElementById('session-meta');
    const st = ed.state;
    if (!st.sessionId) {
      meta.textContent = '未加载会话';
      return;
    }
    const s = st.session || {};
    const src = st.source || {};
    const parts = [];
    parts.push('<b>' + U.esc(src.title || '(未命名窗口)') + '</b>' + (src.process ? ' · ' + U.esc(src.process) : ''));
    parts.push('截图 ' + st.imgW + ' × ' + st.imgH + ' 像素');
    parts.push('捕获 ' + U.fmtTime(s.createdAt || ''));
    parts.push('方法 ' + U.esc(src.method === 'window-source' ? '窗口直取' : src.method === 'screen-crop' ? '屏幕裁剪' : '—'));
    meta.innerHTML = parts.join('<br>');
    updateCounts();
  }

  function focusCard(id) {
    const host = document.getElementById('cards');
    const el = host.querySelector('.card[data-id="' + id + '"]');
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    const ta = el.querySelector('.prompt');
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      try { ta.setSelectionRange(len, len); } catch (e) { /* ignore */ }
    }
  }

  function applyPromptToCard(id, text) {
    const host = document.getElementById('cards');
    const el = host.querySelector('.card[data-id="' + id + '"]');
    if (!el) return;
    const ta = el.querySelector('.prompt');
    if (!ta || document.activeElement === ta) return;
    ta.value = text;
  }

  function peekCoords(id) {
    if (!id) return;
    const host = document.getElementById('cards');
    const el = host.querySelector('.card[data-id="' + id + '"]');
    if (!el) return;
    const a = ed.findAnn(id);
    if (!a) return;
    const pos = el.querySelector('.pos');
    if (pos) pos.textContent = posText(a);
  }

  function removeAnn(id) {
    const st = ed.state;
    ed.pushUndo();
    st.annotations = st.annotations.filter(function (a) { return a.id !== id; });
    if (st.selectedId === id) st.selectedId = null;
    ed.draw();
    renderCards();
    NS.app.touch();
  }

  /* ------------------------------ 会话 ------------------------------ */

  function onSessionLoaded(data) {
    document.getElementById('empty').classList.add('hidden');
    document.getElementById('sb-source').textContent = (data.source && data.source.title ? data.source.title : '未命名窗口') +
      ' · ' + data.width + '×' + data.height;
    document.title = 'FrontDesignHelper · ' + (data.source && data.source.title ? data.source.title : '视觉标注');
    renderCards();
    renderMeta();
    setSaveState('已加载', 'saved');
    lastSeen.id = data.id;
    lastSeen.statuses = statusKey();
    if (data.hasAnnotated === false && data.annotations.length) exportDebounced();
    refreshSessionSelect(true);
    updateBackButton();
  }

  async function loadLatest() {
    try {
      const r = await U.api('listSessions');
      if (r.sessions && r.sessions.length) {
        await ed.loadSession(r.sessions[0].id);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /* ------------------------------ 截取 ------------------------------ */

  function setBusyUI(on) {
    ['btn-capture', 'btn-capture-screen'].forEach(function (id) {
      const b = document.getElementById(id);
      if (b) b.disabled = !!on;
    });
  }

  async function doCapture(args) {
    if (busy) return;
    busy = true;
    setBusyUI(true);
    U.toast('正在截取…（本窗口会短暂隐藏，避免挡住目标）', '', 2000);
    try {
      const r = await U.api('captureTarget', args);
      if (r.warning) U.toast(r.warning, 'warn', 4500);
      await ed.loadSession(r.id);
      U.toast('已截取 ' + r.session.width + ' × ' + r.session.height, 'ok', 2000);
    } catch (e) {
      U.toast('截取失败：' + e.message, 'err', 5200);
    } finally {
      busy = false;
      setBusyUI(false);
    }
  }

  /* ------------------------------ 窗口选择 ------------------------------ */

  function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
  function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

  async function openWindowModal() {
    showModal('modal-window');
    document.getElementById('win-filter').value = '';
    document.getElementById('win-filter').focus();
    await refreshWindows();
  }

  async function refreshWindows() {
    const host = document.getElementById('win-list');
    host.innerHTML = '<div class="empty-line">正在枚举窗口…</div>';
    try {
      const r = await U.api('listWindows');
      windowsCache = r.windows || [];
      renderWinList();
    } catch (e) {
      host.innerHTML = '<div class="empty-line">枚举失败：' + U.esc(e.message) + '</div>';
    }
  }

  let firstPick = null;

  function renderWinList() {
    const host = document.getElementById('win-list');
    const q = String(document.getElementById('win-filter').value || '').trim().toLowerCase();
    const wins = windowsCache.filter(function (w) {
      if (!q) return true;
      return (w.title + ' ' + w.process).toLowerCase().indexOf(q) >= 0;
    });
    host.innerHTML = '';
    const rows = [];
    // 整屏永远作为一个可选项，放在最前面
    rows.push({
      screen: true, process: 'SCREEN', title: '整个屏幕（主显示器）',
      rect: { w: 0, h: 0 }, foreground: false, iconic: false
    });
    wins.forEach(function (w) {
      rows.push({ screen: false, w: w, process: w.process, title: w.title, rect: w.rect, foreground: w.foreground, iconic: w.iconic });
    });
    firstPick = null;
    rows.forEach(function (row) {
      const el = document.createElement('div');
      el.className = 'win-item' + (row.foreground ? ' fg' : '') + (row.iconic ? ' iconic' : '') + (row.screen ? ' screen-row' : '');
      el.innerHTML =
        '<span class="wproc">' + U.esc(row.process || '?') + '</span>' +
        '<span class="wtitle">' + U.esc(row.title) + (row.iconic ? '（已最小化）' : '') + '</span>' +
        '<span class="wmeta">' + (row.screen ? '全屏' : row.rect.w + '×' + row.rect.h) + '</span>';
      const pick = function () {
        hideModal('modal-window');
        if (row.screen) doCapture({ kind: 'screen' });
        else doCapture({ kind: 'window', hwnd: row.w.hwnd, label: row.w.title });
      };
      el.addEventListener('click', pick);
      if (!firstPick && !row.screen) firstPick = pick;
      host.appendChild(el);
    });
    if (!wins.length) {
      const tip = document.createElement('div');
      tip.className = 'empty-line';
      tip.textContent = '没找到其它窗口（当前只有本应用）。请把 Godot / Unity 编辑器窗口显示出来，再点「刷新」；也可以直接用上面这一条截整屏。';
      host.appendChild(tip);
    }
  }

  async function openHistory() {
    showModal('modal-history');
    const host = document.getElementById('hist-list');
    host.innerHTML = '<div class="empty-line">加载中…</div>';
    try {
      const r = await U.api('listSessions');
      const rows = r.sessions || [];
      host.innerHTML = '';
      if (!rows.length) {
        host.innerHTML = '<div class="empty-line">还没有任何截图会话</div>';
        return;
      }
      rows.forEach(function (s) {
        const el = document.createElement('div');
        el.className = 'hist-item';
        el.innerHTML =
          '<div class="hrow"><span class="htitle">' + U.esc(s.source.title) + '</span>' +
          '<span class="hmeta">' + s.width + '×' + s.height + '</span>' +
          '<button class="hdel" title="删除">✕</button></div>' +
          '<div class="hrow"><span class="hmeta">' + U.fmtTime(s.createdAt) + ' · ' + s.annotationCount + ' 条标注 · 待处理 ' + s.counts.pending + '</span></div>';
        el.addEventListener('click', function (e) {
          if (e.target && e.target.classList && e.target.classList.contains('hdel')) return;
          hideModal('modal-history');
          switchSession(s.id).catch(function (err) { U.toast('加载失败：' + err.message, 'err', 4000); });
        });
        el.querySelector('.hdel').addEventListener('click', async function (e) {
          e.stopPropagation();
          try {
            await U.api('deleteSession', { id: s.id });
            U.toast('已删除会话', 'ok', 1800);
            el.parentNode.removeChild(el);
          } catch (err) {
            U.toast('删除失败：' + err.message, 'err', 4000);
          }
        });
        host.appendChild(el);
      });
    } catch (e) {
      host.innerHTML = '<div class="empty-line">读取失败：' + U.esc(e.message) + '</div>';
    }
  }

  /* ------------------------------ 复制指令 / 状态 ------------------------------ */

  async function copyInstructions() {
    if (!ed.state.sessionId) { U.toast('还没有会话可复制', 'warn'); return; }
    try {
      const d = await U.api('getSession', { id: ed.state.sessionId });
      const head = '【FrontDesignHelper 视觉标注指令】\n' +
        '请通过 MCP 工具读取本会话（get_instructions），或用下面的文字 + 图片路径直接落地修改。\n' +
        '会话 ID：' + d.id + '\n\n';
      await U.copyText(head + d.markdown);
      U.toast('指令已复制到剪贴板（含坐标与图片路径）', 'ok', 2600);
    } catch (e) {
      U.toast('复制失败：' + e.message, 'err', 4000);
    }
  }

  async function markAllPending() {
    const st = ed.state;
    if (!st.sessionId) return;
    try {
      const todo = st.annotations.filter(function (a) { return a.status !== 'pending'; });
      for (const a of todo) {
        await U.api('updateAnnotation', { id: st.sessionId, annId: a.id, patch: { status: 'pending', aiNote: '' } });
        a.status = 'pending';
        a.aiNote = '';
      }
      syncCardMeta();
      U.toast('已把 ' + todo.length + ' 条标注置为待处理', 'ok', 2200);
    } catch (e) {
      U.toast('操作失败：' + e.message, 'err', 4000);
    }
  }

  async function markSessionDone() {
    const st = ed.state;
    if (!st.sessionId) return;
    try {
      await U.api('setSessionStatus', { id: st.sessionId, status: 'done' });
      U.toast('会话已标记完成', 'ok', 2000);
    } catch (e) {
      U.toast('操作失败：' + e.message, 'err', 4000);
    }
  }

  /* ------------------------------ 一键让 AI 修改 ------------------------------ */

  function applyAiMode() {
    const isApi = aiMode === 'api';
    const isPaste = aiMode === 'paste';
    const isHeadless = aiMode === 'headless';
    const dshRow = document.getElementById('ai-dsh-row');
    const dshHint = document.getElementById('ai-dsh-hint');
    const convRow = document.getElementById('ai-conv-row');
    const convHint = document.getElementById('ai-conv-hint');
    if (dshRow) dshRow.classList.toggle('hidden', !isPaste);
    if (dshHint) dshHint.classList.toggle('hidden', !isPaste);
    if (convRow) convRow.classList.toggle('hidden', isPaste);
    if (convHint) convHint.classList.toggle('hidden', isPaste);
    const btn = document.getElementById('ai-start');
    if (btn) btn.textContent = isApi ? '投递并开始' : (isPaste ? '复制并粘贴' : '开始后台任务');
    const warn = document.getElementById('ai-run-warn');
    if (warn) {
      warn.textContent = isApi
        ? '点「投递并开始」会调官方接口把指令写进选中的对话，DSH 立刻开始这一轮。若 DSH 界面没立刻刷新，点一下该对话或按 F5 即可（数据已写入）。会消耗 API 额度。'
        : (isPaste
          ? '备用方式：把指令复制到剪贴板，再切到 DSH 窗口粘贴并回车（需要目标窗口在前台）。'
          : '点「开始后台任务」会在后台起一个 headless AI 任务（不打开 DSH）。会消耗 API 额度。');
    }
  }

  function saveAiChoice() {
    try {
      localStorage.setItem('fdh.ai.workspace', aiWorkspace || '');
      localStorage.setItem('fdh.ai.conversation', aiContinueFrom || '');
      localStorage.setItem('fdh.ai.mode', aiMode);
      localStorage.setItem('fdh.ai.window', aiWindowTitle);
      localStorage.setItem('fdh.ai.autopaste', aiAutoPaste ? '1' : '0');
    } catch (e) { /* ignore */ }
  }

  function renderWorkspaceOptions() {
    const sel = document.getElementById('ai-workspace');
    if (!sel) return;
    sel.innerHTML = '';
    aiWorkspaces.forEach(function (w) {
      const o = document.createElement('option');
      o.value = w.path;
      o.textContent = w.name + '（' + w.sessionCount + ' 对话）· ' + w.path;
      if (w.path === aiWorkspace) o.selected = true;
      sel.appendChild(o);
    });
    // 允许当前工作区不在列表里（用浏览…选进来的目录）
    if (aiWorkspace && !aiWorkspaces.some(function (w) { return w.path === aiWorkspace; })) {
      const o = document.createElement('option');
      o.value = aiWorkspace;
      o.textContent = aiWorkspace + '（自定义）';
      o.selected = true;
      sel.insertBefore(o, sel.firstChild);
    }
    if (!sel.value && aiWorkspaces.length) {
      aiWorkspace = aiWorkspaces[0].path;
      sel.value = aiWorkspace;
    }
    sel.value = aiWorkspace;
  }

  function renderConversationOptions() {
    const sel = document.getElementById('ai-conversation');
    if (!sel) return;
    sel.innerHTML = '';
    const fresh = document.createElement('option');
    fresh.value = '';
    fresh.textContent = '＋ 新建对话';
    sel.appendChild(fresh);
    aiConversations.forEach(function (c) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = U.fmtTime(c.updatedAt) + ' · ' + String(c.title || '').slice(0, 28) + '（' + c.messages + ' 条）';
      sel.appendChild(o);
    });
    if (aiContinueFrom && !aiConversations.some(function (c) { return c.id === aiContinueFrom; })) aiContinueFrom = '';
    sel.value = aiContinueFrom || '';
  }

  async function loadAiTargets(preferredWorkspace) {
    const want = preferredWorkspace || aiWorkspace || '';
    let r;
    try {
      r = await U.api('getAgentTargets', { workspace: want });
    } catch (e) {
      U.toast('读取工作区失败：' + e.message, 'err', 4000);
      return;
    }
    aiWorkspaces = r.workspaces || [];
    aiWorkspace = r.workspace || want || (aiWorkspaces[0] ? aiWorkspaces[0].path : '');
    // 请求里没带工作区时，对话列表是空的；用解析出的工作区再取一次，
    // 否则下拉只剩「新建对话」，默认就投到一条 GUI 看不见的新会话里（曾经的真实 bug）
    if (!r.workspace && aiWorkspace) {
      try { r = await U.api('getAgentTargets', { workspace: aiWorkspace }); } catch (e) { /* 保持原值 */ }
    }
    aiConversations = r.conversations || [];
    // 默认选中「DSH 界面上正在看的那条对话」（由窗口标题匹配得出）；猜不到才退到最近一条
    if (!aiContinueFrom && aiConversations.length) {
      aiContinueFrom = r.openSessionId || aiConversations[0].id;
    }
    renderWorkspaceOptions();
    renderConversationOptions();
    if (!r.dshAvailable) U.toast('找不到 DSH，无法启动 AI 任务', 'err', 5000);
  }

  function buildAgentPrompt() {
    const st = ed.state;
    const anns = ed.state.annotations;
    const noPrompt = anns.filter(function (a) { return !String(a.prompt || '').trim(); }).length;
    const lines = [];
    lines.push('你是 FrontDesignHelper 的执行端。用户已经在界面上用「框选 / 挪动」标注了要改的地方，请按步骤工作：');
    lines.push('');
    lines.push('1) 调用 MCP 工具 get_instructions（在 DSH 里工具名形如 mcp__frontdesignhelper__get_instructions，session_id = ' + st.sessionId + '）拿到全部标注。');
    lines.push('2) 标注里的 rect(x,y,w,h) 或 from/to 都是截图像素坐标，原点在截图左上角；');
    lines.push('   若返回的 imageOrigin 不为 (0,0)，真实窗口坐标 = 图片坐标 + imageOrigin。');
    lines.push('3) 用 godot-ai（或该界面所属引擎的）MCP 工具真正修改界面：按提示词改属性、节点位置、锚点与布局。');
    lines.push('4) 每改完一条，立刻调用 frontdesignhelper 的 ack_instruction（annotation_id、status=done、note=一句话说明实际改了什么）。');
    lines.push('5) 做不到的条用 status=skipped，并在 note 里写清原因。');
    lines.push('6) 不要新增截图，不要改动与提示词无关的内容；全部完成后用一句话总结。');
    lines.push('');
    lines.push('工作区（当前目录）：' + (aiWorkspace || '(未指定)'));
    lines.push('来源窗口：' + ((st.source && st.source.title) || '(未知)') + '（' + ((st.source && st.source.process) || '') + '）');
    lines.push('标注共 ' + anns.length + ' 条' + (noPrompt ? ('，其中 ' + noPrompt + ' 条还没有提示词（可跳过）') : ''));
    return lines.join('\n');
  }

  function setAiState(txt, cls) {
    const el = document.getElementById('ai-state');
    if (!el) return;
    el.textContent = txt || '';
    el.className = 'ai-state' + (cls ? ' ' + cls : '');
  }

  function openAiModal() {
    const st = ed.state;
    if (!st.sessionId) { U.toast('先截一张图并加上标注', 'warn'); return; }
    if (!ed.state.annotations.length) { U.toast('还没有标注：先用「框选」圈出要改的地方', 'warn'); return; }
    const anns = ed.state.annotations;
    const noPrompt = anns.filter(function (a) { return !String(a.prompt || '').trim(); }).length;
    document.getElementById('ai-summary').innerHTML =
      '会话 <b>' + U.esc(String(st.sessionId)) + '</b> · 标注 <b>' + anns.length + '</b> 条' +
      (noPrompt ? ('（<b>' + noPrompt + '</b> 条没写提示词，会被跳过）') : '') +
      '<br>来源 ' + U.esc(String((st.source && st.source.title) || '(未知)'));
    document.getElementById('ai-error').textContent = '';
    document.getElementById('modal-ai').classList.remove('hidden');
    document.getElementById('ai-summary').textContent += '';
    // 记住上次的工作区/对话选择
    try {
      // 不恢复上次的工作区/对话：默认永远指向「最近活跃的工作区 + 它的最近一条对话」，
      // 也就是用户此刻最可能在看的那个地方。想投到别处再手动选。
      aiWorkspace = '';
      aiContinueFrom = '';
      aiMode = localStorage.getItem('fdh.ai.mode') || 'api';
      aiWindowTitle = localStorage.getItem('fdh.ai.window') || 'DeepSeek Harness';
      aiAutoPaste = (localStorage.getItem('fdh.ai.autopaste') || '1') === '1';
    } catch (e) { /* ignore */ }
    document.getElementById('ai-mode').value = aiMode;
    document.getElementById('ai-dsh-window').value = aiWindowTitle;
    document.getElementById('ai-autopaste').checked = aiAutoPaste;
    applyAiMode();
    const ta0 = document.getElementById('ai-prompt');
    const auto0 = buildAgentPrompt();
    ta0.value = auto0;
    loadAiTargets(aiWorkspace).then(function () {
      const ta = document.getElementById('ai-prompt');
      // 只有用户没动过指令时才重写，避免异步回填覆盖手改内容
      if (ta.value === auto0 || ta.value.trim() === '') ta.value = buildAgentPrompt();
    });
    U.api('dshStatus', {}).then(function (st) {
      const el = document.getElementById('ai-summary');
      if (!el) return;
      if (st && st.ok) {
        el.innerHTML += '<br><span style="color:#7ff0bd">DSH 接口已连接（端口 ' + st.port + '，' + st.sessions.length + ' 个对话）</span>';
      } else {
        el.innerHTML += '<br><span style="color:#ff9b9b">DSH 接口未连接：' + U.esc(String((st && st.error) || '未知原因')) + '（可用「复制并粘贴」方式）</span>';
      }
    }).catch(function () { /* ignore */ });
  }

  async function startAiRun() {
    const errEl = document.getElementById('ai-error');
    const prompt = document.getElementById('ai-prompt').value.trim();
    if (!prompt) { errEl.textContent = '指令不能为空'; return; }
    const btn = document.getElementById('ai-start');
    btn.disabled = true;
    errEl.textContent = '';
    try {
      await forceSaveNow();
      aiMode = document.getElementById('ai-mode').value || 'dsh';
      aiWindowTitle = String(document.getElementById('ai-dsh-window').value || '').trim() || 'DeepSeek Harness';
      aiAutoPaste = !!document.getElementById('ai-autopaste').checked;
      aiWorkspace = document.getElementById('ai-workspace').value || aiWorkspace;
      aiContinueFrom = document.getElementById('ai-conversation').value || '';
      saveAiChoice();

      if (aiMode === 'api') {
        // 官方接口：写入会话（宿主层），DSH 界面可能需要刷新/打开该对话才看到

        try {
          const r = await U.api('sendToDshConversation', {
            sessionId: aiContinueFrom || '',
            workspace: aiWorkspace,
            prompt: prompt
          });
          document.getElementById('modal-ai').classList.add('hidden');
          aiRunning = true;
          const where = r.created ? '新建对话 ' + String(r.sessionId).slice(0, 22) : '对话 ' + String(r.sessionId).slice(0, 22);
          U.toast('已投递到 DSH（' + where + '），DSH 正在开始这一轮 · 进度会在卡片上更新', 'ok', 6000);
          setAiState('已投递到 DSH（' + String(r.sessionId).slice(-8) + '），等待 AI 回写…', 'running');
          lastDispatchedSession = r.sessionId;
        } catch (e) {
          errEl.textContent = e.message;
          U.toast('投递失败：' + e.message, 'err', 7000);
        }
        btn.disabled = false;
        return;
      }
      if (aiMode === 'paste') {
        const r = await U.api('deliverToDsh', { prompt: prompt, windowTitle: aiWindowTitle, autoPaste: aiAutoPaste });
        document.getElementById('modal-ai').classList.add('hidden');
        if (r.ok && r.verified) {
          U.toast('已送进 DSH 对话「' + (r.sessionTitle || r.sessionId) + '」，DSH 已开始这一轮', 'ok', 6500);
          setAiState('已投递到对话 ' + String(r.sessionId).slice(-8) + '，等待 AI 回写…', 'running');
        } else if (r.ok && r.pasted) {
          U.toast(r.warning || '已粘贴并回车，但没能自动核对到消息，请看一眼 DSH', 'warn', 8000);
          setAiState('已尝试投递，未核对成功', 'failed');
        } else if (r.ok) {
          U.toast('已复制到剪贴板（未自动粘贴）· 到 DSH 输入框按 Ctrl+V 回车即可', 'warn', 6000);
        } else {
          U.toast(r.error || '投递失败', 'err', 8000);
          setAiState('投递失败', 'failed');
        }
        btn.disabled = false;
        return;
      }

      const r = await U.api('startAgentRun', {
        sessionId: ed.state.sessionId,
        prompt: prompt,
        workspace: aiWorkspace,
        continueFrom: aiContinueFrom
      });
      document.getElementById('modal-ai').classList.add('hidden');
      aiRunning = true;
      U.toast('AI 已开始修改 · 日志 ' + r.logPath, 'ok', 5200);
      setAiState('AI 修改中…', 'running');
      pollAiState();
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function pollAiState() {
    try {
      const r = await U.api('getAgentRun', {});
      const run = r && r.run;
      if (!run) { setAiState('', ''); aiRunning = false; return; }
      if (run.running) {
        aiRunning = true;
        const sec = Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000));
        setAiState('AI 修改中… ' + sec + 's', 'running');
      } else {
        aiRunning = false;
        if (run.canceled) setAiState('上次修改已取消', '');
        else if (run.exitCode === 0) setAiState('上次修改完成', '');
        else setAiState('上次修改失败（退出码 ' + run.exitCode + '）', 'failed');
      }
    } catch (e) { /* 忽略 */ }
  }

  async function cancelAiRun() {
    try {
      await U.api('cancelAgentRun', {});
      U.toast('已请求停止 AI 任务', '', 2200);
      pollAiState();
    } catch (e) {
      U.toast('停止失败：' + e.message, 'err', 4000);
    }
  }

  /* ------------------------------ 轮询 ------------------------------ */

  async function pollTick() {
    try {
      const listR = await U.api('listSessions');
      const sessions = listR.sessions || [];
      const newest = sessions[0];
      const st = ed.state;
      if (newest && newest.source && newest.source.requestedBy === 'ai' && newest.id !== st.sessionId && !autoSwitched.has(newest.id)) {
        autoSwitched.add(newest.id);
        await switchSession(newest.id, 'AI 截了新图并切了过去 · 点「← 上一条」可回原会话');
        return;
      }
      if (!st.sessionId) return;
      const d = await U.api('getSession', { id: st.sessionId });
      const memIds = {};
      st.annotations.forEach(function (a) { memIds[a.id] = true; });
      const missing = (d.annotations || []).filter(function (a) { return !memIds[a.id]; });
      if (missing.length) {
        missing.forEach(function (a) { st.annotations.push(JSON.parse(JSON.stringify(a))); });
        renderCards();
        ed.draw();
        exportDebounced();
        U.toast('同步到 ' + missing.length + ' 条新标注', '', 2200);
      }
      const key = d.annotations.map(function (a) { return a.id + ':' + (a.status || '') + ':' + (a.aiNote || ''); }).join('|');
      if (key !== lastSeen.statuses) {
        const byId = {};
        d.annotations.forEach(function (a) { byId[a.id] = a; });
        st.annotations.forEach(function (a) {
          const r = byId[a.id];
          if (!r) return;
          a.status = r.status;
          a.aiNote = r.aiNote;
          if (!dirtyIds.has(a.id) && typeof r.prompt === 'string' && r.prompt !== a.prompt) {
            a.prompt = r.prompt;
            applyPromptToCard(a.id, r.prompt);
          }
        });
        lastSeen.statuses = key;
        syncCardMeta();
        ed.draw();
        const doneNow = d.annotations.filter(function (a) { return a.status === 'done'; }).length;
        U.toast('AI 更新了标注状态（已完成 ' + doneNow + ' 条）', 'ok', 2400);
      }
    } catch (e) { /* 轮询失败静默 */ }
  }

  function bindEvents() {
    if (!window.fdh || !window.fdh.onEvent) return;
    window.fdh.onEvent(function (payload) {
      if (!payload || payload.type !== 'session-created') return;
      if (!payload.id || payload.id === ed.state.sessionId) return;
      if (payload.requestedBy === 'ai') {
        if (autoSwitched.has(payload.id)) return;
        autoSwitched.add(payload.id);
      }
      switchSession(payload.id, payload.requestedBy === 'ai' ? 'AI 截了新图并切了过去 · 点「← 上一条」可回原会话' : '').catch(function (e) {
        U.toast('加载新会话失败：' + e.message, 'err', 4000);
      });
    });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () { pollTick(); pollAiState(); }, 2600);
    refreshSessionSelect(false);
  }

  /* ------------------------------ 初始化 ------------------------------ */

  function wire() {
    document.getElementById('btn-capture').addEventListener('click', openWindowModal);
    document.getElementById('btn-capture-screen').addEventListener('click', function () {
      doCapture({ kind: 'screen' });
    });
    document.getElementById('btn-history').addEventListener('click', openHistory);
    document.getElementById('btn-back').addEventListener('click', function () { goBackSession(); });
    document.getElementById('session-select').addEventListener('change', function (e) {
      switchSession(e.target.value).catch(function (err) { U.toast('切换失败：' + err.message, 'err', 4000); });
    });
    document.getElementById('btn-run-ai').addEventListener('click', function () {
      if (aiRunning) { cancelAiRun(); return; }
      openAiModal();
    });
    document.getElementById('ai-open-dsh').addEventListener('click', async function () {
      try {
        const r = await U.api('openDshUi', {});
        await window.fdh.openExternal(r.url);
        U.toast('已在浏览器打开 DSH：' + r.url, '', 3000);
      } catch (e) {
        U.toast('打开失败：' + e.message, 'err', 5000);
      }
    });
    document.getElementById('ai-start').addEventListener('click', startAiRun);
    document.getElementById('ai-mode').addEventListener('change', function (e) {
      aiMode = e.target.value;
      saveAiChoice();
      applyAiMode();
    });
    document.getElementById('ai-dsh-window').addEventListener('input', function (e) {
      aiWindowTitle = e.target.value;
      saveAiChoice();
    });
    document.getElementById('ai-autopaste').addEventListener('change', function (e) {
      aiAutoPaste = !!e.target.checked;
      saveAiChoice();
    });
    document.getElementById('ai-workspace').addEventListener('change', async function (e) {
      aiWorkspace = e.target.value;
      aiContinueFrom = '';
      saveAiChoice();
      await loadAiTargets(aiWorkspace);
      document.getElementById('ai-prompt').value = buildAgentPrompt();
    });
    document.getElementById('ai-conversation').addEventListener('change', function (e) {
      aiContinueFrom = e.target.value || '';
      saveAiChoice();
      document.getElementById('ai-prompt').value = buildAgentPrompt();
    });
    document.getElementById('ai-refresh').addEventListener('click', async function () {
      await loadAiTargets(aiWorkspace);
      document.getElementById('ai-prompt').value = buildAgentPrompt();
    });
    document.getElementById('ai-pick-dir').addEventListener('click', async function () {
      try {
        const r = await U.api('pickDirectory', {});
        if (!r || r.canceled || !r.path) return;
        aiWorkspace = r.path;
        aiContinueFrom = '';
        saveAiChoice();
        await loadAiTargets(aiWorkspace);
        document.getElementById('ai-prompt').value = buildAgentPrompt();
      } catch (err) {
        U.toast('选择目录失败：' + err.message, 'err', 4000);
      }
    });
    document.getElementById('ai-close').addEventListener('click', function () { document.getElementById('modal-ai').classList.add('hidden'); });
    var aiX = document.querySelector('[data-close-ai]');
    if (aiX) aiX.addEventListener('click', function () { document.getElementById('modal-ai').classList.add('hidden'); });
    U.$$('.toolbtn').forEach(function (b) {
      b.addEventListener('click', function () { ed.setTool(b.dataset.tool); });
    });
    document.getElementById('btn-undo').addEventListener('click', function () { ed.undo(); });
    document.getElementById('btn-delete').addEventListener('click', function () { ed.deleteSelected(); });
    document.getElementById('btn-fit').addEventListener('click', function () { ed.fit(); });
    document.getElementById('btn-zoom100').addEventListener('click', function () { ed.zoom100(); });
    document.getElementById('chk-overlay').addEventListener('change', function (e) { ed.setOverlay(e.target.checked); });
    document.getElementById('btn-copy').addEventListener('click', copyInstructions);
    document.getElementById('btn-datadir').addEventListener('click', async function () {
      const r = await window.fdh.openDataDir();
      if (r && r.path) U.toast('数据目录：' + r.path, '', 2600);
    });
    document.getElementById('btn-mark-open').addEventListener('click', markAllPending);
    document.getElementById('btn-mark-done').addEventListener('click', markSessionDone);
    document.getElementById('win-refresh').addEventListener('click', refreshWindows);
    document.getElementById('win-filter').addEventListener('input', renderWinList);
    document.getElementById('win-filter').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && typeof firstPick === 'function') { e.preventDefault(); firstPick(); }
    });
    U.$$('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        hideModal('modal-window');
        hideModal('modal-history');
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideModal('modal-window'); hideModal('modal-history'); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openWindowModal();
      }
    });
    window.addEventListener('beforeunload', function () { saveDebounced.flush(); });
  }

  async function initMcpChip() {
    const chip = document.getElementById('mcp-chip');
    try {
      const info = await window.fdh.bridgeInfo();
      if (info && info.mcpAvailable) {
        chip.className = 'chip ok';
        chip.textContent = 'MCP 就绪 · ' + info.port;
        chip.title = 'MCP 桥接端口 ' + info.port + '\n运行时文件：' + info.runtimeFile;
      } else {
        chip.className = 'chip bad';
        chip.textContent = 'MCP 未启动';
        chip.title = '本地桥接端口没有启动，AI 无法连接';
      }
    } catch (e) {
      chip.className = 'chip bad';
      chip.textContent = 'MCP 未知';
    }
  }

  async function init() {
    ed = NS.editor;
    NS.app = {
      touch: function () {
        // 结构变化（新增/删除/撤销）必须重建卡片；只有内容变化时原地更新，避免打断输入
        const host = document.getElementById('cards');
        if (host.children.length !== ed.state.annotations.length) {
          renderCards();
        } else {
          syncCardMeta();
        }
        saveDebounced();
        updateCounts();
      },
      forceSave: function () { saveDebounced.cancel(); doSave(); },
      selectionChanged: syncSelection,
      focusCard: focusCard,
      peekCoords: peekCoords,
      onSessionLoaded: onSessionLoaded,
      redo: ed.redo
    };
    wire();
    bindEvents();
    ed.setTool('select');
    await initMcpChip();
    const ok = await loadLatest();
    if (!ok) {
      document.getElementById('empty').classList.remove('hidden');
      document.getElementById('sb-source').textContent = '还没有截图';
    }
    startPolling();
    refreshSessionSelect(true);
    updateBackButton();
    pollAiState();
  }


  /* ------------------------------ UI 自检钩子 ------------------------------ */
  // 只接受固定动作类型（tool / drag / click / prompt / key），不接受任意脚本。
  function firePointer(el, type, x, y) {
    const r = el.getBoundingClientRect();
    const ev = new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: r.left + x, clientY: r.top + y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1
    });
    el.dispatchEvent(ev);
  }

  function uiSnapshot() {
    const cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
    const prompts = cards.map(function (c) { return c.querySelector('.prompt'); });
    const active = document.querySelector('.toolbtn.active');
    return {
      tool: active ? active.dataset.tool : '',
      cards: cards.length,
      prompts: prompts.map(function (p) { return p.value; }),
      focusedIndex: prompts.indexOf(document.activeElement),
      positions: cards.map(function (c) { return c.querySelector('.pos').textContent; }),
      hint: document.getElementById('hint').textContent,
      saveState: document.getElementById('save-state').textContent,
      pending: document.getElementById('pending-count').textContent,
      coords: document.getElementById('sb-coords').textContent,
      zoom: document.getElementById('sb-zoom').textContent,
      emptyVisible: !document.getElementById('empty').classList.contains('hidden'),
      sessionMeta: document.getElementById('session-meta').textContent,
      sessionId: ed.state.sessionId,
      modalAiOpen: !document.getElementById('modal-ai').classList.contains('hidden'),
      aiState: document.getElementById('ai-state').textContent,
      aiPromptLen: document.getElementById('ai-prompt').value.length,
      aiMode: document.getElementById('ai-mode').value,
      aiWorkspace: document.getElementById('ai-workspace').value,
      aiWorkspaceCount: document.getElementById('ai-workspace').options.length,
      aiConversation: document.getElementById('ai-conversation').value,
      aiConversationCount: document.getElementById('ai-conversation').options.length,
      sessionSelect: document.getElementById('session-select').value,
      backDisabled: document.getElementById('btn-back').disabled,
      imageLoaded: !!(ed.state && ed.state.img),
      annotations: ed.state.annotations.length
    };
  }

  window.__fdhDebugRun = function (actions) {
    const canvasEl = document.getElementById('canvas');
    const log = [];
    const list = Array.isArray(actions) ? actions : [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i] || {};
      if (a.type === 'tool') {
        const btn = document.querySelector('.toolbtn[data-tool="' + a.name + '"]');
        if (btn) btn.click();
        log.push('tool=' + a.name);
      } else if (a.type === 'drag') {
        const x1 = Number(a.x1) || 0, y1 = Number(a.y1) || 0;
        const x2 = Number(a.x2) || 0, y2 = Number(a.y2) || 0;
        firePointer(canvasEl, 'pointerdown', x1, y1);
        for (let s = 1; s <= 4; s++) {
          firePointer(canvasEl, 'pointermove', x1 + (x2 - x1) * s / 4, y1 + (y2 - y1) * s / 4);
        }
        firePointer(canvasEl, 'pointerup', x2, y2);
        log.push('drag ' + x1 + ',' + y1 + '->' + x2 + ',' + y2);
      } else if (a.type === 'click') {
        const x = Number(a.x) || 0, y = Number(a.y) || 0;
        firePointer(canvasEl, 'pointerdown', x, y);
        firePointer(canvasEl, 'pointerup', x, y);
        log.push('click ' + x + ',' + y);
      } else if (a.type === 'prompt') {
        const cards = document.querySelectorAll('.card');
        const idx = Number(a.index) || 0;
        const ta = cards[idx] ? cards[idx].querySelector('.prompt') : null;
        if (ta) {
          ta.focus();
          ta.value = String(a.text == null ? '' : a.text);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          log.push('prompt[' + idx + ']');
        } else {
          log.push('prompt[' + idx + '] MISSING');
        }
      } else if (a.type === 'clickSel') {
        const el = document.querySelector(a.selector);
        if (el) { el.click(); log.push('click ' + a.selector); }
        else { log.push('click MISSING ' + a.selector); }
      } else if (a.type === 'setValue') {
        const el = document.querySelector(a.selector);
        if (el) {
          el.value = String(a.text == null ? '' : a.text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          log.push('set ' + a.selector);
        } else { log.push('set MISSING ' + a.selector); }
      } else if (a.type === 'key') {
        const mods = { key: a.key, code: a.code || '', bubbles: true, ctrlKey: !!a.ctrl, shiftKey: !!a.shift, altKey: !!a.alt, metaKey: !!a.meta };
        window.dispatchEvent(new KeyboardEvent('keydown', mods));
        window.dispatchEvent(new KeyboardEvent('keyup', mods));
        log.push('key=' + (a.ctrl ? 'Ctrl+' : '') + (a.shift ? 'Shift+' : '') + a.key);
      }
    }
    const snap = uiSnapshot();
    snap.log = log;
    return snap;
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.FDH);