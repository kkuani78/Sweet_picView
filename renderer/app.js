/* PicView - 화면 로직 */
'use strict';

const $ = (s) => document.querySelector(s);
/* global api, PptxGenJS */ // api: preload.js에서 제공
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

// ---------------- 상태 ----------------
const state = {
  folder: null,        // 현재 폴더 경로
  all: [],             // 폴더의 전체 이미지
  view: [],            // 검색/정렬 후 화면에 보이는 목록
  selected: new Set(), // 선택된 경로
  focus: -1,           // 포커스 위치 (view 인덱스)
  anchor: -1,          // Shift 범위 선택 기준
  sortBy: 'name',
  sortAsc: true,
  query: '',
  recursive: false,
  rotation: new Map(), // 경로 → 회전 각도 (0/90/180/270)
  loadToken: 0
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('pv.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pv.' + k, JSON.stringify(v)); } catch {} }
};

const imgUrl = (p) => 'localimg://f/' + encodeURIComponent(p);
const extOf = (n) => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase(); };
const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const fmtDate = (ms) => { if (!ms) return ''; const d = new Date(ms); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

// ---------------- 알림 ----------------
function toast(msg, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.error ? ' err' : '');
  el.innerHTML = `<div>${msg}</div>`;
  if (opts.actions) {
    const box = document.createElement('div');
    box.className = 't-actions';
    for (const a of opts.actions) {
      const b = document.createElement('button');
      b.className = 'btn'; b.textContent = a.label;
      b.onclick = () => { a.run(); el.remove(); };
      box.appendChild(b);
    }
    el.appendChild(box);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.ms || 6000);
}

// ---------------- 폴더 트리 ----------------
async function buildTree() {
  const tree = $('#tree');
  tree.innerHTML = '';
  const roots = await api.getRoots();
  let sepAdded = false;
  for (const r of roots) {
    if (r.kind === 'drive' && !sepAdded) { const s = document.createElement('div'); s.className = 'tree-sep'; tree.appendChild(s); sepAdded = true; }
    tree.appendChild(makeNode(r.label, r.path, 0, r.kind === 'drive' ? '💽' : '⭐'));
  }
}

function makeNode(label, p, depth, icon = '📁') {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'node';
  row.dataset.path = p;
  row.style.paddingLeft = (6 + depth * 14) + 'px';
  row.innerHTML = `<span class="twisty">▶</span><span class="ico">${icon}</span><span class="lbl"></span>`;
  row.querySelector('.lbl').textContent = label;
  row.title = p;
  const kids = document.createElement('div');
  kids.className = 'hidden';
  let loaded = false;
  const tw = row.querySelector('.twisty');
  async function toggle(forceOpen) {
    const open = forceOpen === true ? true : kids.classList.contains('hidden');
    if (open && !loaded) {
      loaded = true;
      const res = await api.listDir(p);
      if (!res.dirs.length) tw.classList.add('none');
      for (const d of res.dirs) kids.appendChild(makeNode(d.name, d.path, depth + 1));
    }
    kids.classList.toggle('hidden', !open);
    tw.textContent = open ? '▼' : '▶';
  }
  tw.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  row.addEventListener('click', () => { openFolder(p); toggle(true); });
  row.addEventListener('dblclick', (e) => { e.stopPropagation(); });
  wrap.appendChild(row);
  wrap.appendChild(kids);
  return wrap;
}

function markTreeActive() {
  document.querySelectorAll('.node.active').forEach((n) => n.classList.remove('active'));
  if (!state.folder) return;
  document.querySelectorAll('.node').forEach((n) => { if (n.dataset.path === state.folder) n.classList.add('active'); });
}

// ---------------- 폴더 열기 ----------------
async function openFolder(p, focusPath) {
  if (!p) return;
  const token = ++state.loadToken;
  $('#pathBar').value = p;
  let images;
  if (state.recursive) {
    $('#stCount').textContent = '하위 폴더 검색 중…';
    images = await api.listRecursive(p);
  } else {
    const res = await api.listDir(p, { imagesOnly: true });
    if (res.error) { toast('폴더를 열 수 없습니다: ' + esc(res.error), { error: true }); return; }
    images = res.images;
  }
  if (token !== state.loadToken) return;
  state.folder = p;
  state.all = images.map((it) => ({ ...it, ext: extOf(it.name), url: imgUrl(it.path) }));
  state.selected.clear();
  state.focus = -1; state.anchor = -1;
  store.set('lastFolder', p);
  thumbQueue.length = 0;
  applyView();
  markTreeActive();
  if (focusPath) {
    const i = state.view.findIndex((x) => x.path === focusPath);
    if (i >= 0) { setFocus(i); selectOnly(i); }
  }
  $('#gridWrap').scrollTop = 0;
  $('#gridWrap').focus();
}

function applyView() {
  const q = state.query.trim().toLowerCase();
  let v = q ? state.all.filter((x) => x.name.toLowerCase().includes(q)) : state.all.slice();
  const dir = state.sortAsc ? 1 : -1;
  const by = state.sortBy;
  v.sort((a, b) => {
    let r = 0;
    if (by === 'mtime') r = a.mtime - b.mtime;
    else if (by === 'size') r = a.size - b.size;
    else if (by === 'type') r = collator.compare(a.ext, b.ext);
    if (r === 0) r = collator.compare((a.rel || '') + '/' + a.name, (b.rel || '') + '/' + b.name);
    return r * dir;
  });
  state.view = v;
  renderGrid();
}

// ---------------- 썸네일 ----------------
const thumbCache = new Map(); // path → {url, w, h}
const thumbQueue = [];
let thumbActive = 0;
const THUMB_MAX = 360;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽을 수 없음'));
    img.src = url;
  });
}

async function makeThumb(item) {
  if (thumbCache.has(item.path)) return thumbCache.get(item.path);
  const img = await loadImage(item.url);
  let w = img.naturalWidth || 300, h = img.naturalHeight || 300;
  const s = Math.min(1, THUMB_MAX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.85));
  const t = { url: URL.createObjectURL(blob), w, h };
  thumbCache.set(item.path, t);
  return t;
}

function pumpThumbs() {
  while (thumbActive < 4 && thumbQueue.length) {
    const tile = thumbQueue.pop(); // 최근에 보인 것부터
    if (!tile.isConnected) continue;
    const item = state.view[+tile.dataset.i];
    if (!item || item.path !== tile.dataset.path) continue;
    thumbActive++;
    makeThumb(item).then((t) => {
      item.w = t.w; item.h = t.h;
      fillTile(tile, item, t);
      if (state.focus >= 0 && state.view[state.focus] === item) updatePreview();
    }).catch(() => {
      item.broken = true;
      const th = tile.querySelector('.thumb');
      th.innerHTML = '<span class="ph">미리보기 불가</span>';
    }).finally(() => { thumbActive--; pumpThumbs(); });
  }
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      observer.unobserve(e.target);
      const item = state.view[+e.target.dataset.i];
      if (item && thumbCache.has(item.path)) fillTile(e.target, item, thumbCache.get(item.path));
      else thumbQueue.push(e.target);
    }
  }
  pumpThumbs();
}, { root: document.getElementById('gridWrap'), rootMargin: '400px' });

function fillTile(tile, item, t) {
  const th = tile.querySelector('.thumb');
  th.innerHTML = '';
  const img = document.createElement('img');
  img.src = t.url; img.draggable = false;
  const r = state.rotation.get(item.path) || 0;
  if (r) img.style.transform = `rotate(${r}deg)`;
  th.appendChild(img);
  tile.querySelector('.meta').textContent = `${t.w}×${t.h} · ${fmtSize(item.size)}`;
}


// 회전이 적용된 작은 미리보기 이미지 (CSS 회전 시 잘리는 문제 방지)
const rotThumbCache = new Map();
async function displayUrl(item) {
  const r = state.rotation.get(item.path) || 0;
  const t = thumbCache.get(item.path) || await makeThumb(item);
  if (!r) return t.url;
  const key = item.path + '|' + r;
  if (rotThumbCache.has(key)) return rotThumbCache.get(key);
  const img = await loadImage(t.url);
  const c = document.createElement('canvas');
  c.width = r % 180 ? img.naturalHeight : img.naturalWidth;
  c.height = r % 180 ? img.naturalWidth : img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate(r * Math.PI / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  const url = c.toDataURL('image/png');
  rotThumbCache.set(key, url);
  return url;
}

// ---------------- 그리드 ----------------
function renderGrid() {
  const grid = $('#grid');
  observer.disconnect();
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.view.forEach((item, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile' + (state.selected.has(item.path) ? ' sel' : '');
    tile.dataset.i = i;
    tile.dataset.path = item.path;
    tile.title = item.path;
    tile.innerHTML = `<div class="thumb"><span class="ph">…</span></div><div class="check">✓</div>${item.ext ? `<span class="badge">${esc(item.ext.toUpperCase())}</span>` : ''}<div class="name"></div><div class="meta"></div>`;
    tile.querySelector('.name').textContent = item.rel ? item.rel + ' / ' + item.name : item.name;
    tile.querySelector('.meta').textContent = fmtSize(item.size);
    frag.appendChild(tile);
  });
  grid.appendChild(frag);
  grid.querySelectorAll('.tile').forEach((t) => observer.observe(t));
  $('#empty').classList.toggle('hidden', state.view.length > 0);
  if (state.folder && !state.view.length) {
    $('#empty').querySelector('div:nth-child(2)').innerHTML = state.query ? '검색 결과가 없습니다.' : '이 폴더에는 이미지가 없습니다.';
  }
  updateStatus();
}

function tileAt(i) { return $('#grid').children[i]; }

function refreshSelClasses() {
  const tiles = $('#grid').children;
  for (let i = 0; i < tiles.length; i++) {
    const item = state.view[i];
    tiles[i].classList.toggle('sel', state.selected.has(item.path));
  }
  updateStatus();
}

function setFocus(i, scroll = true) {
  if (state.focus >= 0 && tileAt(state.focus)) tileAt(state.focus).classList.remove('focus');
  state.focus = i;
  const t = tileAt(i);
  if (t) { t.classList.add('focus'); if (scroll) t.scrollIntoView({ block: 'nearest' }); }
  updatePreview();
}

function selectOnly(i) { state.selected.clear(); if (i >= 0) state.selected.add(state.view[i].path); state.anchor = i; refreshSelClasses(); }
function toggleSel(i) { const p = state.view[i].path; state.selected.has(p) ? state.selected.delete(p) : state.selected.add(p); state.anchor = i; refreshSelClasses(); }
function selectRange(a, b, additive) {
  if (!additive) state.selected.clear();
  const [s, e] = a < b ? [a, b] : [b, a];
  for (let k = s; k <= e; k++) state.selected.add(state.view[k].path);
  refreshSelClasses();
}
function selectAll() { state.view.forEach((x) => state.selected.add(x.path)); refreshSelClasses(); }
function selectNone() { state.selected.clear(); refreshSelClasses(); }
function selectInvert() { state.view.forEach((x) => state.selected.has(x.path) ? state.selected.delete(x.path) : state.selected.add(x.path)); refreshSelClasses(); }

function selectedItems() { return state.view.filter((x) => state.selected.has(x.path)); }

function updateStatus() {
  const n = state.view.length;
  $('#stCount').textContent = state.folder ? `이미지 ${n.toLocaleString()}개` + (n !== state.all.length ? ` (전체 ${state.all.length.toLocaleString()}개 중)` : '') : '';
  const sel = selectedItems();
  const total = sel.reduce((s, x) => s + (x.size || 0), 0);
  $('#stSel').textContent = sel.length ? `${sel.length.toLocaleString()}개 선택 · ${fmtSize(total)}` : '';
  $('#selInfo').innerHTML = sel.length ? `<b>${sel.length.toLocaleString()}</b>개 선택됨` : '선택 없음';
  $('#stPath').textContent = state.folder || '';
}

function updatePreview() {
  const item = state.view[state.focus];
  const img = $('#previewImg');
  if (!item) { img.removeAttribute('src'); $('#previewInfo').innerHTML = ''; return; }
  const t = thumbCache.get(item.path);
  img.src = t ? t.url : item.url;
  if (state.rotation.get(item.path)) displayUrl(item).then((u) => { if (state.view[state.focus] === item) img.src = u; }).catch(() => {});
  $('#previewInfo').innerHTML = `<b>${esc(item.name)}</b><br>${item.w ? `${item.w} × ${item.h} px · ` : ''}${fmtSize(item.size)}<br>${fmtDate(item.mtime)}`;
}

// 그리드 마우스 조작
const gridWrap = $('#gridWrap');
let rubber = null;

gridWrap.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const tile = e.target.closest('.tile');
  if (tile) {
    const i = +tile.dataset.i;
    if (e.target.closest('.check')) { toggleSel(i); setFocus(i, false); return; }
    if (e.shiftKey && state.anchor >= 0) { selectRange(state.anchor, i, e.ctrlKey || e.metaKey); setFocus(i, false); }
    else if (e.ctrlKey || e.metaKey) { toggleSel(i); setFocus(i, false); }
    else {
      if (!state.selected.has(state.view[i].path) || state.selected.size === 1) selectOnly(i);
      else state.anchor = i;
      setFocus(i, false);
    }
    return;
  }
  // 빈 곳에서 드래그 → 영역 선택
  if (e.target === gridWrap || e.target.id === 'grid') {
    const rect = gridWrap.getBoundingClientRect();
    if (e.clientX > rect.right - 14 || e.clientY > rect.bottom - 14) return; // 스크롤바
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    rubber = {
      x0: e.clientX - rect.left + gridWrap.scrollLeft,
      y0: e.clientY - rect.top + gridWrap.scrollTop,
      base: additive ? new Set(state.selected) : new Set(),
      lastX: e.clientX, lastY: e.clientY, moved: false
    };
    if (!additive) selectNone();
    e.preventDefault();
  }
});

function updateRubber() {
  if (!rubber) return;
  const rect = gridWrap.getBoundingClientRect();
  const x1 = rubber.lastX - rect.left + gridWrap.scrollLeft;
  const y1 = rubber.lastY - rect.top + gridWrap.scrollTop;
  const L = Math.min(rubber.x0, x1), T = Math.min(rubber.y0, y1);
  const W = Math.abs(x1 - rubber.x0), H = Math.abs(y1 - rubber.y0);
  const box = $('#rubber');
  box.style.display = 'block';
  box.style.left = L + 'px'; box.style.top = T + 'px'; box.style.width = W + 'px'; box.style.height = H + 'px';
  const next = new Set(rubber.base);
  const tiles = $('#grid').children;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const tl = t.offsetLeft, tt = t.offsetTop, tw = t.offsetWidth, th = t.offsetHeight;
    if (tl < L + W && tl + tw > L && tt < T + H && tt + th > T) {
      const p = state.view[i].path;
      if (rubber.base.has(p)) next.delete(p); else next.add(p);
    }
  }
  state.selected = next;
  refreshSelClasses();
}

window.addEventListener('mousemove', (e) => {
  if (!rubber) return;
  rubber.lastX = e.clientX; rubber.lastY = e.clientY; rubber.moved = true;
  requestAnimationFrame(updateRubber);
});
window.addEventListener('mouseup', () => {
  if (!rubber) return;
  if (rubber.moved) updateRubber();
  rubber = null;
  $('#rubber').style.display = 'none';
});
// 드래그 중 가장자리에서 자동 스크롤
setInterval(() => {
  if (!rubber) return;
  const r = gridWrap.getBoundingClientRect();
  let dy = 0;
  if (rubber.lastY < r.top + 30) dy = -24; else if (rubber.lastY > r.bottom - 30) dy = 24;
  if (dy) { gridWrap.scrollTop += dy; updateRubber(); }
}, 30);

gridWrap.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.tile');
  if (tile && !e.target.closest('.check')) openViewer(+tile.dataset.i);
});

gridWrap.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const tile = e.target.closest('.tile');
  if (tile) {
    const i = +tile.dataset.i;
    if (!state.selected.has(state.view[i].path)) selectOnly(i);
    setFocus(i, false);
  }
  showContextMenu(e.clientX, e.clientY, !!tile);
});

// ---------------- 우클릭 메뉴 ----------------
function showContextMenu(x, y, onTile) {
  const m = $('#ctxMenu');
  const item = state.view[state.focus];
  const n = state.selected.size;
  const items = [];
  if (onTile && item) {
    items.push(['크게 보기', 'Enter', () => openViewer(state.focus)]);
    items.push(['기본 프로그램으로 열기', '', () => api.openPath(item.path)]);
    items.push(['탐색기에서 위치 열기', '', () => api.showInFolder(item.path)]);
    items.push(null);
    items.push(['오른쪽으로 회전', 'R', () => rotateSelected(90)]);
    items.push(['왼쪽으로 회전', 'L', () => rotateSelected(-90)]);
    items.push(null);
  }
  items.push(['모두 선택', 'Ctrl+A', selectAll]);
  items.push(['선택 해제', 'Esc', selectNone]);
  items.push(['선택 반전', 'Ctrl+I', selectInvert]);
  if (n) {
    items.push(null);
    items.push([`선택한 ${n}개 PPT로 내보내기`, 'Ctrl+E', () => openDialog('ppt')]);
    items.push([`선택한 ${n}개 인쇄`, 'Ctrl+P', () => openDialog('print')]);
  }
  m.innerHTML = '';
  for (const it of items) {
    if (!it) { const s = document.createElement('div'); s.className = 'ms'; m.appendChild(s); continue; }
    const d = document.createElement('div');
    d.className = 'mi';
    d.innerHTML = `<span>${esc(it[0])}</span><span class="k">${esc(it[1])}</span>`;
    d.onclick = () => { hideContextMenu(); it[2](); };
    m.appendChild(d);
  }
  m.classList.remove('hidden');
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.min(x, innerWidth - mw - 6) + 'px';
  m.style.top = Math.min(y, innerHeight - mh - 6) + 'px';
}
function hideContextMenu() { $('#ctxMenu').classList.add('hidden'); }
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxMenu')) hideContextMenu(); });
window.addEventListener('blur', hideContextMenu);

function rotateSelected(deg) {
  const targets = state.selected.size ? selectedItems() : (state.view[state.focus] ? [state.view[state.focus]] : []);
  for (const it of targets) {
    const r = (((state.rotation.get(it.path) || 0) + deg) % 360 + 360) % 360;
    if (r) state.rotation.set(it.path, r); else state.rotation.delete(it.path);
    const i = state.view.indexOf(it);
    const img = tileAt(i)?.querySelector('.thumb img');
    if (img) img.style.transform = r ? `rotate(${r}deg)` : '';
  }
  updatePreview();
}

// ---------------- 키보드 (그리드) ----------------
function gridCols() {
  const tiles = $('#grid').children;
  if (tiles.length < 2) return 1;
  const top0 = tiles[0].offsetTop;
  let c = 0;
  while (c < tiles.length && tiles[c].offsetTop === top0) c++;
  return c || 1;
}

document.addEventListener('keydown', (e) => {
  if (!$('#viewer').classList.contains('hidden')) return viewerKey(e);
  if (!$('#modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeDialog();
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); $('#dlgOk').click(); }
    return;
  }
  const inInput = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'range';
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); pickFolder(); return; }
  if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (e.key === 'F5') { e.preventDefault(); openFolder(state.folder); return; }
  if (inInput) return;
  const n = state.view.length;
  if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
  if (ctrl && e.key.toLowerCase() === 'i') { e.preventDefault(); selectInvert(); return; }
  if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); openDialog('ppt'); return; }
  if (ctrl && e.key.toLowerCase() === 'p') { e.preventDefault(); openDialog('print'); return; }
  if (e.key === 'Escape') { selectNone(); return; }
  if (e.key === 'Backspace') { e.preventDefault(); goUp(); return; }
  if (!n) return;
  if (e.key === 'Enter') { if (state.focus >= 0) openViewer(state.focus); return; }
  if (e.key === ' ') { e.preventDefault(); if (state.focus >= 0) toggleSel(state.focus); return; }
  if (e.key.toLowerCase() === 'r' && !ctrl) { rotateSelected(e.shiftKey ? -90 : 90); return; }
  if (e.key.toLowerCase() === 'l' && !ctrl) { rotateSelected(-90); return; }
  const cols = gridCols();
  let to = null;
  const f = state.focus < 0 ? 0 : state.focus;
  if (e.key === 'ArrowRight') to = Math.min(n - 1, state.focus < 0 ? 0 : f + 1);
  else if (e.key === 'ArrowLeft') to = Math.max(0, f - 1);
  else if (e.key === 'ArrowDown') to = Math.min(n - 1, state.focus < 0 ? 0 : f + cols);
  else if (e.key === 'ArrowUp') to = Math.max(0, f - cols);
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = n - 1;
  else if (e.key === 'PageDown') to = Math.min(n - 1, f + cols * 4);
  else if (e.key === 'PageUp') to = Math.max(0, f - cols * 4);
  if (to !== null) {
    e.preventDefault();
    if (e.shiftKey) { if (state.anchor < 0) state.anchor = f; selectRange(state.anchor, to, false); }
    else if (!ctrl) selectOnly(to);
    setFocus(to);
  }
});

// ---------------- 뷰어 ----------------
const V = { idx: -1, s: 1, tx: 0, ty: 0, fit: true, show: null, idleT: null, nw: 0, nh: 0 };

function openViewer(i) {
  if (i < 0 || i >= state.view.length) return;
  $('#viewer').classList.remove('hidden');
  showInViewer(i);
  pokeIdle();
}

function closeViewer() {
  stopSlideshow();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('#viewer').classList.add('hidden');
  if (V.idx >= 0) { setFocus(V.idx); }
  gridWrap.focus();
}

function showInViewer(i) {
  const n = state.view.length;
  if (!n) return;
  i = (i + n) % n;
  V.idx = i;
  const item = state.view[i];
  const img = $('#vImg');
  img.style.opacity = '0';
  img.onload = () => {
    V.nw = img.naturalWidth || 800; V.nh = img.naturalHeight || 600;
    item.w = V.nw; item.h = V.nh;
    img.style.width = V.nw + 'px'; img.style.height = V.nh + 'px';
    fitView();
    img.style.opacity = '1';
    $('#vInfo').textContent = `${V.nw} × ${V.nh} px · ${fmtSize(item.size)} · ${fmtDate(item.mtime)}`;
  };
  img.onerror = () => { $('#vInfo').textContent = '이 이미지를 표시할 수 없습니다.'; };
  img.src = item.url;
  $('#vName').textContent = item.rel ? item.rel + ' / ' + item.name : item.name;
  $('#vCounter').textContent = `${i + 1} / ${n}`;
  updateViewerSelBtn();
  // 다음 이미지 미리 읽기
  const nx = state.view[(i + 1) % n];
  if (nx) { const pre = new Image(); pre.src = nx.url; }
}

function rotOf(i) { return state.rotation.get(state.view[i]?.path) || 0; }

function fitView() {
  const st = $('#vStage');
  const r = rotOf(V.idx);
  const rw = r % 180 ? V.nh : V.nw, rh = r % 180 ? V.nw : V.nh;
  V.s = Math.min(1, st.clientWidth / rw, st.clientHeight / rh);
  V.tx = 0; V.ty = 0; V.fit = true;
  applyTransform();
}

function applyTransform() {
  const r = rotOf(V.idx);
  $('#vImg').style.transform = `translate(-50%, -50%) translate(${V.tx}px, ${V.ty}px) scale(${V.s}) rotate(${r}deg)`;
  $('#vZoom').textContent = Math.round(V.s * 100) + '%';
}

function zoomAt(factor, cx, cy) {
  const st = $('#vStage').getBoundingClientRect();
  const mx = (cx ?? st.left + st.width / 2) - (st.left + st.width / 2);
  const my = (cy ?? st.top + st.height / 2) - (st.top + st.height / 2);
  const ns = Math.max(0.02, Math.min(32, V.s * factor));
  V.tx = mx - (mx - V.tx) * (ns / V.s);
  V.ty = my - (my - V.ty) * (ns / V.s);
  V.s = ns; V.fit = false;
  applyTransform();
}

function updateViewerSelBtn() {
  const item = state.view[V.idx];
  const on = item && state.selected.has(item.path);
  const b = $('#vSelBtn');
  b.textContent = on ? '☑ 선택됨' : '☐ 선택';
  b.classList.toggle('on', !!on);
}

function viewerAction(act) {
  switch (act) {
    case 'prev': showInViewer(V.idx - 1); break;
    case 'next': showInViewer(V.idx + 1); break;
    case 'zoomIn': zoomAt(1.25); break;
    case 'zoomOut': zoomAt(0.8); break;
    case 'fit': fitView(); break;
    case 'actual': V.s = 1; V.tx = 0; V.ty = 0; V.fit = false; applyTransform(); break;
    case 'rotL': rotateItem(V.idx, -90); fitView(); break;
    case 'rotR': rotateItem(V.idx, 90); fitView(); break;
    case 'select': toggleSel(V.idx); updateViewerSelBtn(); break;
    case 'slideshow': V.show ? stopSlideshow() : startSlideshow(); break;
    case 'full': document.fullscreenElement ? document.exitFullscreen() : $('#viewer').requestFullscreen(); break;
    case 'close': closeViewer(); break;
  }
}

function rotateItem(i, deg) {
  const it = state.view[i];
  const r = (((state.rotation.get(it.path) || 0) + deg) % 360 + 360) % 360;
  if (r) state.rotation.set(it.path, r); else state.rotation.delete(it.path);
  const img = tileAt(i)?.querySelector('.thumb img');
  if (img) img.style.transform = r ? `rotate(${r}deg)` : '';
}

function startSlideshow() {
  V.show = setInterval(() => showInViewer(V.idx + 1), 3000);
  $('#vShowBtn').classList.add('on'); $('#vShowBtn').textContent = '■ 정지';
}
function stopSlideshow() {
  clearInterval(V.show); V.show = null;
  $('#vShowBtn').classList.remove('on'); $('#vShowBtn').textContent = '▶ 슬라이드쇼';
}

function viewerKey(e) {
  const k = e.key;
  if (k === 'Escape' || k === 'Enter') { e.preventDefault(); if (k === 'Escape' && document.fullscreenElement) { return; } closeViewer(); }
  else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { e.preventDefault(); viewerAction('next'); }
  else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace') { e.preventDefault(); viewerAction('prev'); }
  else if (k === 'Home') showInViewer(0);
  else if (k === 'End') showInViewer(state.view.length - 1);
  else if (k === '+' || k === '=') viewerAction('zoomIn');
  else if (k === '-') viewerAction('zoomOut');
  else if (k === '0') viewerAction('fit');
  else if (k === '1') viewerAction('actual');
  else if (k.toLowerCase() === 'r') viewerAction(e.shiftKey ? 'rotL' : 'rotR');
  else if (k.toLowerCase() === 'l') viewerAction('rotL');
  else if (k.toLowerCase() === 's') viewerAction('select');
  else if (k.toLowerCase() === 'f' || k === 'F11') { e.preventDefault(); viewerAction('full'); }
  else if (k === 'F5') { e.preventDefault(); viewerAction('slideshow'); }
  pokeIdle();
}

$('#vBar').addEventListener('click', (e) => { const b = e.target.closest('.vbtn'); if (b) viewerAction(b.dataset.act); });
const vStage = $('#vStage');
vStage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || V.s > 0) zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
}, { passive: false });
let pan = null;
vStage.addEventListener('mousedown', (e) => { if (e.button === 0) { pan = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty, moved: false }; vStage.classList.add('drag'); } });
window.addEventListener('mousemove', (e) => {
  if ($('#viewer').classList.contains('hidden')) return;
  pokeIdle();
  if (!pan) return;
  const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
  V.tx = pan.tx + dx; V.ty = pan.ty + dy; V.fit = false;
  applyTransform();
});
window.addEventListener('mouseup', () => { pan = null; vStage.classList.remove('drag'); });
vStage.addEventListener('dblclick', () => { V.fit ? viewerAction('actual') : fitView(); });
window.addEventListener('resize', () => { if (!$('#viewer').classList.contains('hidden') && V.fit) fitView(); });
function pokeIdle() {
  $('#viewer').classList.remove('idle');
  clearTimeout(V.idleT);
  V.idleT = setTimeout(() => $('#viewer').classList.add('idle'), 2500);
}

// ---------------- 레이아웃 계산 (PPT/인쇄 공용) ----------------
// 한 장에 n개를 넣을 때, 이미지가 가장 크게 보이는 가로×세로 칸 수를 찾는다.
function bestGrid(n, W, H, aspect, capH, gap) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (W - gap * (cols - 1)) / cols;
    const ch = (H - gap * (rows - 1)) / rows - capH;
    if (cw <= 0 || ch <= 0) continue;
    const iw = Math.min(cw, ch * aspect);
    const area = iw * (iw / aspect);
    const waste = cols * rows - n;
    const score = area * (1 - waste * 0.02);
    if (!best || score > best.score) best = { cols, rows, score };
  }
  return best || { cols: 1, rows: n };
}

function typicalAspect(items) {
  const a = items.filter((x) => x.w && x.h).map((x) => { const r = state.rotation.get(x.path) || 0; return r % 180 ? x.h / x.w : x.w / x.h; }).sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : 4 / 3;
}

// 레이아웃 결과: pages = [[{item, x, y, w, h, capY}...]], 단위는 W/H와 같음
function computeLayout(items, opt, W, H, marginV, gap, capH) {
  const innerW = W - marginV * 2, innerH = H - marginV * 2;
  let cols, rows, per;
  if (opt.custom) { cols = opt.cols; rows = opt.rows; per = cols * rows; }
  else { per = opt.per; const g = bestGrid(per, innerW, innerH, typicalAspect(items), capH, gap); cols = g.cols; rows = g.rows; }
  const cw = (innerW - gap * (cols - 1)) / cols;
  const ch = (innerH - gap * (rows - 1)) / rows;
  const pages = [];
  for (let p = 0; p < items.length; p += per) {
    const cells = [];
    items.slice(p, p + per).forEach((item, k) => {
      const c = k % cols, r = Math.floor(k / cols);
      cells.push({ item, x: marginV + c * (cw + gap), y: marginV + r * (ch + gap), w: cw, h: ch });
    });
    pages.push(cells);
  }
  return { pages, cols, rows, per, cw, ch };
}

// ---------------- 이미지 준비 ----------------
const PPT_OK = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'bmp']);

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}

// 회전/축소/형식변환을 적용한 이미지 데이터 (dataURL, 회전 반영된 w/h)
async function prepareImage(item, { maxSide = 0, forPpt = false } = {}) {
  const r = state.rotation.get(item.path) || 0;
  const img = await loadImage(item.url);
  const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600;
  const needScale = maxSide && Math.max(nw, nh) > maxSide;
  const needConvert = forPpt && !PPT_OK.has(item.ext);
  const outW = r % 180 ? nh : nw, outH = r % 180 ? nw : nh;
  if (!r && !needScale && !needConvert) {
    if (!forPpt) return { src: item.url, w: nw, h: nh };
    const bytes = await api.readFile(item.path);
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp' }[item.ext] || 'application/octet-stream';
    const data = await blobToDataURL(new Blob([bytes], { type: mime }));
    return { src: data, w: nw, h: nh };
  }
  const s = needScale ? maxSide / Math.max(nw, nh) : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(outW * s); c.height = Math.round(outH * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const alpha = ['png', 'gif', 'webp', 'svg', 'ico', 'avif'].includes(item.ext);
  if (!alpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(r * Math.PI / 180);
  ctx.drawImage(img, -nw * s / 2, -nh * s / 2, nw * s, nh * s);
  const type = alpha ? 'image/png' : 'image/jpeg';
  return { src: c.toDataURL(type, 0.92), w: outW, h: outH };
}

function fitRect(cell, w, h, capH, fill) {
  const availH = cell.h - capH;
  if (fill) return { x: cell.x, y: cell.y, w: cell.w, h: availH };
  const s = Math.min(cell.w / w, availH / h);
  const iw = w * s, ih = h * s;
  return { x: cell.x + (cell.w - iw) / 2, y: cell.y + (availH - ih) / 2, w: iw, h: ih };
}

// ---------------- 내보내기/인쇄 대화상자 ----------------
const SLIDE = { '16x9': [13.333, 7.5], '4x3': [10, 7.5], 'a4l': [11.693, 8.268], 'a4p': [8.268, 11.693] }; // inch
const PAPER = { A4: [210, 297], A3: [297, 420], B5: [182, 257], Letter: [215.9, 279.4] }; // mm
const MARGIN_IN = { none: 0, narrow: 0.2, normal: 0.4, wide: 0.7 };
const MARGIN_MM = { none: 0, narrow: 5, normal: 10, wide: 18 };
const PER_CHOICES = [1, 2, 3, 4, 6, 8, 9, 12, 16, 20];

const dlg = { mode: null, items: [], per: 4, busy: false };

function openDialog(mode) {
  let items = selectedItems();
  let note = '';
  if (!state.view.length) { toast('먼저 이미지가 있는 폴더를 여세요.', { error: true }); return; }
  if (!items.length) {
    items = state.view.slice();
    note = `<div class="warn">선택한 이미지가 없어 화면의 이미지 전체를 대상으로 합니다.</div>`;
  }
  dlg.mode = mode; dlg.items = items;
  const isPpt = mode === 'ppt';
  $('#dlgTitle').textContent = isPpt ? '📊 PowerPoint로 내보내기' : '🖨 인쇄';
  $('#perLabel').textContent = isPpt ? '슬라이드 한 장에 넣을 이미지 수' : '종이 한 장에 인쇄할 이미지 수';
  $('#dlgTarget').innerHTML = `대상: <b>${items.length.toLocaleString()}장</b>의 이미지` + note;
  $('#fSlideSize').classList.toggle('hidden', !isPpt);
  $('#fPaper').classList.toggle('hidden', isPpt);
  $('#fOptimize').classList.toggle('hidden', !isPpt);
  $('#dlgPdf').classList.toggle('hidden', isPpt);
  $('#dlgOk').textContent = isPpt ? '내보내기' : '인쇄하기';

  const s = store.get(mode + 'Opt', {});
  dlg.per = s.per || (isPpt ? 4 : 4);
  $('#customGrid').checked = !!s.custom;
  $('#gCols').value = s.cols || 3; $('#gRows').value = s.rows || 2;
  $('#slideSize').value = s.slide || '16x9';
  $('#paper').value = s.paper || 'A4';
  $('#orient').value = s.orient || 'portrait';
  $('#margin').value = s.margin || 'normal';
  $('#caption').checked = !!s.caption;
  $('#fillCell').checked = !!s.fill;
  $('#optimize').checked = s.optimize !== false;

  const chips = $('#perBtns');
  chips.innerHTML = '';
  for (const n of PER_CHOICES) {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = n + '장'; b.dataset.n = n;
    b.onclick = () => { dlg.per = n; $('#customGrid').checked = false; syncDialog(); };
    chips.appendChild(b);
  }
  setProgress(null);
  $('#modal').classList.remove('hidden');
  syncDialog();
  // 썸네일이 아직 없는 대상 이미지의 크기 정보를 채워서 미리보기 정확도 향상
  ensureDims(items.slice(0, 40)).then(() => { if (!$('#modal').classList.contains('hidden')) syncDialog(); });
}

async function ensureDims(items) {
  await Promise.all(items.filter((x) => !x.w).map((x) => makeThumb(x).then((t) => { x.w = t.w; x.h = t.h; }).catch(() => {})));
}

function readOpts() {
  return {
    per: dlg.per,
    custom: $('#customGrid').checked,
    cols: Math.max(1, Math.min(10, +$('#gCols').value || 1)),
    rows: Math.max(1, Math.min(10, +$('#gRows').value || 1)),
    slide: $('#slideSize').value,
    paper: $('#paper').value,
    orient: $('#orient').value,
    margin: $('#margin').value,
    caption: $('#caption').checked,
    fill: $('#fillCell').checked,
    optimize: $('#optimize').checked
  };
}

function pageGeometry(o) {
  if (dlg.mode === 'ppt') {
    const [W, H] = SLIDE[o.slide];
    return { W, H, margin: MARGIN_IN[o.margin], gap: o.margin === 'none' ? 0.05 : 0.15, capH: o.caption ? 0.32 : 0, unit: 'in' };
  }
  let [W, H] = PAPER[o.paper];
  if (o.orient === 'landscape') [W, H] = [H, W];
  return { W, H, margin: MARGIN_MM[o.margin], gap: o.margin === 'none' ? 1.5 : 4, capH: o.caption ? 6 : 0, unit: 'mm' };
}

function syncDialog() {
  const o = readOpts();
  store.set(dlg.mode + 'Opt', o);
  $('#customInputs').classList.toggle('dim', !o.custom);
  document.querySelectorAll('#perBtns .chip').forEach((c) => c.classList.toggle('on', !o.custom && +c.dataset.n === o.per));
  const g = pageGeometry(o);
  const L = computeLayout(dlg.items, o, g.W, g.H, g.margin, g.gap, g.capH);
  const unitName = dlg.mode === 'ppt' ? '슬라이드' : '페이지';
  $('#pvPages').textContent = `${L.cols}×${L.rows} 배치 · 총 ${L.pages.length}${unitName}`;
  // 미리보기 그리기
  const box = $('#pvBox');
  const maxW = box.clientWidth - 32, maxH = box.clientHeight - 32;
  const sc = Math.min(maxW / g.W, maxH / g.H);
  const page = $('#pvPage');
  page.style.width = g.W * sc + 'px'; page.style.height = g.H * sc + 'px';
  page.innerHTML = '';
  const first = L.pages[0] || [];
  const slots = o.custom ? o.cols * o.rows : L.per;
  for (let k = 0; k < slots; k++) {
    const c = k % L.cols, r = Math.floor(k / L.cols);
    const cell = first[k] || { x: g.margin + c * (L.cw + g.gap), y: g.margin + r * (L.ch + g.gap), w: L.cw, h: L.ch };
    const d = document.createElement('div');
    d.className = 'pv-cell' + (first[k] ? '' : ' empty') + (o.fill ? ' fill' : '');
    Object.assign(d.style, { left: cell.x * sc + 'px', top: cell.y * sc + 'px', width: cell.w * sc + 'px', height: cell.h * sc + 'px' });
    if (first[k]) {
      const it = first[k].item;
      const t = thumbCache.get(it.path);
      const wrap = document.createElement('div'); wrap.className = 'pv-img';
      const im = document.createElement('img');
      im.src = t ? t.url : it.url;
      if (state.rotation.get(it.path)) displayUrl(it).then((u) => { im.src = u; }).catch(() => {});
      wrap.appendChild(im); d.appendChild(wrap);
      if (o.caption) { const cap = document.createElement('div'); cap.className = 'pv-cap'; cap.textContent = it.name; cap.style.fontSize = Math.max(6, Math.min(10, g.capH * sc * 0.6)) + 'px'; d.appendChild(cap); }
    }
    page.appendChild(d);
  }
}

['#customGrid', '#gCols', '#gRows', '#slideSize', '#paper', '#orient', '#margin', '#caption', '#fillCell', '#optimize'].forEach((s) => {
  $(s).addEventListener('input', syncDialog);
  $(s).addEventListener('change', syncDialog);
});
$('#gCols').addEventListener('focus', () => { $('#customGrid').checked = true; syncDialog(); });
$('#gRows').addEventListener('focus', () => { $('#customGrid').checked = true; syncDialog(); });
$('#customInputs').addEventListener('mousedown', () => { if (!$('#customGrid').checked) { $('#customGrid').checked = true; syncDialog(); } });
$('#dlgClose').onclick = closeDialog;
$('#dlgCancel').onclick = closeDialog;
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeDialog(); });
$('#dlgOk').onclick = () => (dlg.mode === 'ppt' ? doExportPpt() : doPrint(false));
$('#dlgPdf').onclick = () => doPrint(true);

function closeDialog() { if (dlg.busy) return; $('#modal').classList.add('hidden'); }

function setProgress(done, total, text) {
  const p = $('#dlgProgress');
  if (done == null) { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  $('#progBar').style.width = (total ? (done / total) * 100 : 0) + '%';
  $('#progText').textContent = text || `${done} / ${total}`;
}

function setBusy(b) {
  dlg.busy = b;
  ['#dlgOk', '#dlgPdf', '#dlgCancel'].forEach((s) => ($(s).disabled = b));
}

function stamp() { const d = new Date(); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`; }

// ---------------- PPT 내보내기 ----------------
async function doExportPpt() {
  if (dlg.busy) return;
  const o = readOpts();
  const g = pageGeometry(o);
  const items = dlg.items;
  setBusy(true);
  try {
    await ensureDims(items);
    const L = computeLayout(items, o, g.W, g.H, g.margin, g.gap, g.capH);
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'PV', width: g.W, height: g.H });
    pptx.layout = 'PV';
    pptx.title = state.folder ? baseName(state.folder) : 'PicView';
    let done = 0;
    for (const cells of L.pages) {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      for (const cell of cells) {
        let prep;
        try { prep = await prepareImage(cell.item, { maxSide: o.optimize ? 2000 : 0, forPpt: true }); }
        catch { prep = null; }
        if (prep) {
          const r = fitRect(cell, prep.w, prep.h, g.capH, o.fill);
          const opts = { data: prep.src, x: r.x, y: r.y, w: r.w, h: r.h };
          if (o.fill) opts.sizing = { type: 'cover', w: r.w, h: r.h };
          slide.addImage(opts);
        } else {
          slide.addText('읽을 수 없는 이미지', { x: cell.x, y: cell.y, w: cell.w, h: cell.h - g.capH, align: 'center', color: '999999', fontSize: 10 });
        }
        if (o.caption) {
          slide.addText(cell.item.name, {
            x: cell.x, y: cell.y + cell.h - g.capH, w: cell.w, h: g.capH,
            align: 'center', valign: 'middle', fontSize: Math.max(7, Math.min(12, cell.w * 2.2)), color: '333333', fontFace: '맑은 고딕', fit: 'shrink'
          });
        }
        done++;
        setProgress(done, items.length, `이미지 준비 중 ${done} / ${items.length}`);
      }
    }
    setProgress(items.length, items.length, 'PPT 파일 만드는 중…');
    const buf = await pptx.write({ outputType: 'arraybuffer' });
    const name = `${state.folder ? baseName(state.folder).replace(/[\\/:*?"<>|]/g, '') : '이미지'}_${stamp()}.pptx`;
    const saved = await api.saveFile(new Uint8Array(buf), name, 'PowerPoint', 'pptx');
    setBusy(false);
    if (saved) {
      closeDialog();
      toast(`PPT 저장 완료 (${L.pages.length}슬라이드)<br><span style="color:#a3a9b5;font-size:12px">${esc(saved)}</span>`, {
        ms: 12000,
        actions: [{ label: '파일 열기', run: () => api.openPath(saved) }, { label: '폴더 열기', run: () => api.showInFolder(saved) }]
      });
      window.__lastSaved = saved;
    } else setProgress(null);
  } catch (err) {
    setBusy(false); setProgress(null);
    toast('PPT 내보내기 실패: ' + esc(err.message || err), { error: true });
    console.error(err);
  }
}

// ---------------- 인쇄 ----------------
async function doPrint(toPdf) {
  if (dlg.busy) return;
  const o = readOpts();
  const g = pageGeometry(o);
  const items = dlg.items;
  setBusy(true);
  try {
    await ensureDims(items);
    const L = computeLayout(items, o, g.W, g.H, g.margin, g.gap, g.capH);
    const pageSize = o.paper;
    const landscape = o.orient === 'landscape';
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { size: ${g.W}mm ${g.H}mm; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .page { position: relative; width: ${g.W}mm; height: ${(g.H - 0.6).toFixed(2)}mm; overflow: hidden; page-break-after: always; break-after: page; }
      .page:last-child { page-break-after: auto; break-after: auto; }
      .im { position: absolute; display: block; }
      .fill { object-fit: cover; }
      .cap { position: absolute; text-align: center; font-family: "Malgun Gothic", sans-serif; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    </style></head><body>`;
    let done = 0;
    for (const cells of L.pages) {
      html += '<div class="page">';
      for (const cell of cells) {
        let prep;
        try { prep = await prepareImage(cell.item, {}); } catch { prep = null; }
        if (prep) {
          const r = fitRect(cell, prep.w, prep.h, g.capH, o.fill);
          html += `<img class="im${o.fill ? ' fill' : ''}" src="${esc(prep.src)}" style="left:${r.x.toFixed(2)}mm;top:${r.y.toFixed(2)}mm;width:${r.w.toFixed(2)}mm;height:${r.h.toFixed(2)}mm">`;
        }
        if (o.caption) {
          html += `<div class="cap" style="left:${cell.x.toFixed(2)}mm;top:${(cell.y + cell.h - g.capH).toFixed(2)}mm;width:${cell.w.toFixed(2)}mm;height:${g.capH}mm;line-height:${g.capH}mm;font-size:${Math.max(6, Math.min(10, cell.w / 9)).toFixed(1)}pt">${esc(cell.item.name)}</div>`;
        }
        done++;
        setProgress(done, items.length, `인쇄 준비 중 ${done} / ${items.length}`);
      }
      html += '</div>';
    }
    html += '</body></html>';
    setProgress(items.length, items.length, toPdf ? 'PDF 만드는 중…' : '프린터 창을 여는 중…');
    const pdfName = `${state.folder ? baseName(state.folder).replace(/[\\/:*?"<>|]/g, '') : '이미지'}_인쇄_${stamp()}.pdf`;
    const res = await api.printHtml(html, { pageSize, landscape, toPdf, pdfName });
    setBusy(false);
    if (res && res.ok) {
      closeDialog();
      if (toPdf) {
        toast(`PDF 저장 완료 (${L.pages.length}페이지)<br><span style="color:#a3a9b5;font-size:12px">${esc(res.path)}</span>`, {
          ms: 12000, actions: [{ label: '파일 열기', run: () => api.openPath(res.path) }, { label: '폴더 열기', run: () => api.showInFolder(res.path) }]
        });
        window.__lastSaved = res.path;
      } else toast(`인쇄를 보냈습니다 (${L.pages.length}페이지)`);
    } else {
      setProgress(null);
      if (res && res.reason && res.reason !== 'cancelled' && !res.canceled) toast('인쇄 실패: ' + esc(res.reason), { error: true });
    }
  } catch (err) {
    setBusy(false); setProgress(null);
    toast('인쇄 실패: ' + esc(err.message || err), { error: true });
    console.error(err);
  }
}

// ---------------- 상단 툴바 ----------------
async function pickFolder() { const p = await api.pickFolder(); if (p) openFolder(p); }
async function goUp() { if (!state.folder) return; const p = await api.parentDir(state.folder); if (p) openFolder(p); }

$('#btnOpen').onclick = pickFolder;
$('#btnUp').onclick = goUp;
$('#btnRefresh').onclick = () => openFolder(state.folder);
$('#pathBar').addEventListener('keydown', (e) => { if (e.key === 'Enter') { openFolder(e.target.value.trim()); } });
$('#search').addEventListener('input', (e) => { state.query = e.target.value; state.selected.clear(); state.focus = -1; applyView(); });
$('#sortBy').addEventListener('change', (e) => { state.sortBy = e.target.value; store.set('sortBy', state.sortBy); applyView(); });
$('#btnSortDir').onclick = () => { state.sortAsc = !state.sortAsc; $('#btnSortDir').textContent = state.sortAsc ? '↑' : '↓'; store.set('sortAsc', state.sortAsc); applyView(); };
$('#thumbSize').addEventListener('input', (e) => { document.documentElement.style.setProperty('--ts', e.target.value + 'px'); store.set('thumbSize', +e.target.value); });
$('#chkRecursive').addEventListener('change', (e) => { state.recursive = e.target.checked; openFolder(state.folder); });
$('#btnSelAll').onclick = selectAll;
$('#btnSelNone').onclick = selectNone;
$('#btnSelInvert').onclick = selectInvert;
$('#btnPpt').onclick = () => openDialog('ppt');
$('#btnPrint').onclick = () => openDialog('print');
gridWrap.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const s = $('#thumbSize');
  s.value = Math.max(80, Math.min(320, +s.value + (e.deltaY < 0 ? 20 : -20)));
  s.dispatchEvent(new Event('input'));
}, { passive: false });

// 끌어다 놓기
gridWrap.addEventListener('dragover', (e) => { e.preventDefault(); gridWrap.classList.add('dragover'); });
gridWrap.addEventListener('dragleave', () => gridWrap.classList.remove('dragover'));
gridWrap.addEventListener('drop', async (e) => {
  e.preventDefault(); gridWrap.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const p = api.pathForFile(f);
  if (!p) return;
  const res = await api.listDir(p, { imagesOnly: true });
  if (!res.error) openFolder(p);
  else { const parent = await api.parentDir(p); if (parent) openFolder(parent, p); }
});

// ---------------- 시작 ----------------
(async function init() {
  const ts = store.get('thumbSize', 160);
  $('#thumbSize').value = ts; document.documentElement.style.setProperty('--ts', ts + 'px');
  state.sortBy = store.get('sortBy', 'name'); $('#sortBy').value = state.sortBy;
  state.sortAsc = store.get('sortAsc', true); $('#btnSortDir').textContent = state.sortAsc ? '↑' : '↓';
  await buildTree();
  const last = store.get('lastFolder', null);
  if (last) {
    const res = await api.listDir(last, { imagesOnly: true });
    if (!res.error) openFolder(last);
  }
  updateStatus();
})();

// 테스트/디버그용 접근자
window.__pv = { state, openFolder, selectAll, selectRange, openDialog, doExportPpt, doPrint, dlg, syncDialog, openViewer, closeViewer };
