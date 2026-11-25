/* Sweet Ref - 레퍼런스 보드 (PureRef 방식) */
'use strict';

const T = window.__TAURI__;
const inv = (c, a, o) => T.core.invoke(c, a, o);
const W = T.window.getCurrentWindow();
const $ = (s) => document.querySelector(s);
const root = $('#root'), stage = $('#stage'), world = $('#world');

const DISPLAY_MAX = 2048;       // 화면용으로 줄이는 크기 (확대하면 원본으로 바꿈)
const NATIVE = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'];
const ALL_IMG = NATIVE.concat(['tif', 'tiff', 'tga', 'exr', 'psd', 'psb', 'iff', 'clip', 'heic', 'heif',
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw']);

// ---------------- 상태 ----------------
const B = {
  items: [],              // 화면 순서 = 배열 순서 (뒤가 위)
  sel: new Set(),         // 선택된 id
  view: { x: 0, y: 0, z: 1 },
  nextId: 1,
  gray: false, onTop: false, opacity: 1,
  file: null, dirty: false,
  undo: [], redo: [],
  crop: null              // 자르기 중인 item id
};
const srcCache = new Map();  // id → { disp, full, nw, nh } (지워도 되돌리기 위해 유지)
const blobs = new Map();     // 'b1' → { blob, mime } (붙여넣기·보드 파일에서 온 원본)
let blobSeq = 1;

const extOf = (n) => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase(); };
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const imgUrl = (p) => T.core.convertFileSrc(p, 'localimg');

// ---------------- 알림 / 대화상자 ----------------
let toastT = 0;
function toast(msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
function ask(msg, buttons) {
  return new Promise((resolve) => {
    $('#dlgMsg').innerHTML = msg;
    const box = $('#dlgBtns'); box.innerHTML = '';
    buttons.forEach(([label, val, primary]) => {
      const b = document.createElement('button');
      b.textContent = label; if (primary) b.className = 'primary';
      b.onclick = () => { $('#dlg').classList.add('hidden'); resolve(val); };
      box.appendChild(b);
    });
    $('#dlg').classList.remove('hidden');
  });
}

// ---------------- 화면 변환 ----------------
function applyView() {
  const v = B.view;
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
  world.style.setProperty('--inv', 1 / v.z);
  updateSelBox();
  scheduleHiRes();
}
const toWorld = (sx, sy) => { const r = stage.getBoundingClientRect(); return { x: (sx - r.left - B.view.x) / B.view.z, y: (sy - r.top - B.view.y) / B.view.z }; };
const toScreen = (wx, wy) => ({ x: wx * B.view.z + B.view.x, y: wy * B.view.z + B.view.y });

function zoomAt(f, sx, sy) {
  const r = stage.getBoundingClientRect();
  const mx = sx - r.left, my = sy - r.top;
  const nz = Math.max(0.01, Math.min(50, B.view.z * f));
  B.view.x = mx - (mx - B.view.x) * (nz / B.view.z);
  B.view.y = my - (my - B.view.y) * (nz / B.view.z);
  B.view.z = nz;
  applyView();
}

// 아이템의 화면상 사각형(회전 반영)
function bounds(it) {
  const bw = it.rot % 180 ? it.h : it.w, bh = it.rot % 180 ? it.w : it.h;
  return { x: it.cx - bw / 2, y: it.cy - bh / 2, w: bw, h: bh };
}
function unionBounds(list) {
  if (!list.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of list) { const b = bounds(it); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function fitTo(b, pad = 0.06) {
  if (!b) return;
  const r = stage.getBoundingClientRect();
  const z = Math.min(r.width / b.w, r.height / b.h) * (1 - pad * 2);
  B.view.z = Math.max(0.01, Math.min(50, z));
  B.view.x = r.width / 2 - (b.x + b.w / 2) * B.view.z;
  B.view.y = r.height / 2 - (b.y + b.h / 2) * B.view.z;
  applyView();
}
const fitAll = () => fitTo(unionBounds(B.items));

// ---------------- 아이템 그리기 ----------------
const TEXT_COLORS = { '흰색': '#ffffff', '검정': '#111111', '빨강': '#ff4d4f', '노랑': '#ffd23f', '파랑': '#4c9bff', '초록': '#3ddc84' };
const TEXT_BGS = { '없음': 'transparent', '어두운 상자': 'rgba(0,0,0,.65)', '밝은 상자': 'rgba(255,255,255,.9)' };
const isText = (it) => it.type === 'text';

function makeEl(it) {
  const el = document.createElement('div');
  el.dataset.id = it.id;
  it.el = el;
  if (isText(it)) {
    el.className = 'item text';
    const tx = document.createElement('div');
    tx.className = 'tx';
    tx.textContent = it.text;
    el.appendChild(tx);
    return el;
  }
  el.className = 'item';
  const img = document.createElement('img');
  img.draggable = false;
  el.appendChild(img);
  it.el = el;
  it.hi = false;
  const c = srcCache.get(it.id);
  if (c) img.src = c.disp;
  return el;
}

function render(it) {
  const el = it.el;
  if (isText(it)) { renderText(it); return; }
  el.style.left = (it.cx - it.w / 2) + 'px';
  el.style.top = (it.cy - it.h / 2) + 'px';
  el.style.width = it.w + 'px';
  el.style.height = it.h + 'px';
  el.style.transform = `rotate(${it.rot}deg) scale(${it.fh ? -1 : 1}, ${it.fv ? -1 : 1})`;
  const img = el.firstChild, c = it.crop;
  img.style.width = (it.w / c.w) + 'px';
  img.style.height = (it.h / c.h) + 'px';
  img.style.left = (-c.x * it.w / c.w) + 'px';
  img.style.top = (-c.y * it.h / c.h) + 'px';
  el.classList.toggle('sel', B.sel.has(it.id));
}

// 텍스트: 글자 크기로 상자 크기를 재고(world 단위) 가운데 기준으로 놓는다
function renderText(it) {
  const el = it.el, tx = el.firstChild;
  if (tx.getAttribute('contenteditable') !== 'true' && tx.textContent !== it.text) tx.textContent = it.text;
  tx.style.fontSize = it.fs + 'px';
  tx.style.fontWeight = it.bold ? 700 : 400;
  tx.style.color = it.color;
  tx.style.background = it.bg;
  el.style.width = 'auto'; el.style.height = 'auto';
  el.style.transform = 'none';
  it.w = Math.max(tx.offsetWidth, it.fs); it.h = Math.max(tx.offsetHeight, it.fs);
  el.style.left = (it.cx - it.w / 2) + 'px';
  el.style.top = (it.cy - it.h / 2) + 'px';
  el.classList.toggle('sel', B.sel.has(it.id));
}

function renderAll() {
  // 순서 맞추기
  const want = B.items.map((it) => it.el || makeEl(it));
  const cur = Array.from(world.children);
  if (cur.length !== want.length || cur.some((e, i) => e !== want[i])) {
    world.replaceChildren(...want);
  }
  B.items.forEach(render);
  $('#empty').classList.toggle('hidden', B.items.length > 0);
  updateSelBox();
  scheduleHiRes();
}

function updateSelBox() {
  const box = $('#selbox');
  const sel = selItems();
  if (!sel.length || B.crop) { box.style.display = 'none'; return; }
  const b = unionBounds(sel);
  const p = toScreen(b.x, b.y);
  box.style.display = 'block';
  box.style.left = p.x + 'px'; box.style.top = p.y + 'px';
  box.style.width = b.w * B.view.z + 'px'; box.style.height = b.h * B.view.z + 'px';
}

// 크게 확대하면 원본 해상도로
let hiT = 0;
function scheduleHiRes() { clearTimeout(hiT); hiT = setTimeout(checkHiRes, 200); }
function checkHiRes() {
  for (const it of B.items) {
    if (it.hi || !it.el) continue;
    const c = srcCache.get(it.id);
    if (!c || !c.full || c.full === c.disp) continue;
    const shown = (it.w / it.crop.w) * B.view.z;     // 화면에 보이는 원본 가로 픽셀
    const dispW = Math.min(c.nw, DISPLAY_MAX * (c.nw >= c.nh ? 1 : c.nw / c.nh));
    if (shown > dispW * 1.15) { it.hi = true; it.el.firstChild.src = c.full; }
  }
}

const selItems = () => B.items.filter((it) => B.sel.has(it.id));
const byId = (id) => B.items.find((it) => it.id === id);

// ---------------- 되돌리기 ----------------
const snap = () => JSON.stringify(B.items.map(({ el, hi, ...rest }) => rest));
function pushUndo() {
  B.undo.push(snap());
  if (B.undo.length > 80) B.undo.shift();
  B.redo = [];
  markDirty();
}
function restore(s) {
  const data = JSON.parse(s);
  const old = new Map(B.items.map((it) => [it.id, it]));
  // 같은 id라도 종류가 다르면 새로 그리기
  B.items = data.map((d) => { const o = old.get(d.id); return Object.assign(o || {}, d, { el: o ? o.el : null, hi: o ? o.hi : false }); });
  for (const id of [...B.sel]) if (!byId(id)) B.sel.delete(id);
  renderAll();
  markDirty();
}
function undo() { if (editing) finishEdit(); if (!B.undo.length) return; B.redo.push(snap()); restore(B.undo.pop()); }
function redo() { if (!B.redo.length) return; B.undo.push(snap()); restore(B.redo.pop()); }

function markDirty() { B.dirty = true; updateTitle(); }
function updateTitle() {
  const name = B.file ? baseName(B.file) : '새 보드';
  const t = `Sweet Ref — ${name}${B.dirty ? ' *' : ''}`;
  $('#title').textContent = t;
  W.setTitle(t).catch(() => {});
}

// ---------------- 이미지 불러오기 ----------------
function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.decoding = 'async';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('이미지를 읽을 수 없음'));
    im.src = url;
  });
}

// url의 이미지를 읽어 화면용(축소) 주소를 만든다
async function prepare(url) {
  const im = await loadImg(url);
  const nw = im.naturalWidth || 800, nh = im.naturalHeight || 600;
  if (Math.max(nw, nh) <= DISPLAY_MAX) return { disp: url, full: url, nw, nh };
  const s = DISPLAY_MAX / Math.max(nw, nh);
  const c = document.createElement('canvas');
  c.width = Math.round(nw * s); c.height = Math.round(nh * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(im, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.9));
  return { disp: URL.createObjectURL(blob), full: url, nw, nh };
}

function newItem(src, name, info, at) {
  const it = {
    id: B.nextId++, src, name,
    cx: at.x, cy: at.y, w: info.nw, h: info.nh,
    rot: 0, fh: false, fv: false, crop: { x: 0, y: 0, w: 1, h: 1 }
  };
  srcCache.set(it.id, info);
  return it;
}

// 여러 장을 한 줄로 놓기 (at: 첫 장 왼쪽 위 기준)
async function addSources(list, at) {
  if (!list.length) return;
  const added = [];
  let failed = 0;
  // 기준 높이: 현재 화면 높이의 60%에 해당하는 world 크기를 넘지 않게
  const r = stage.getBoundingClientRect();
  const maxH = (r.height * 0.6) / B.view.z;
  let x = at.x;
  for (const s of list) {
    try {
      const info = await prepare(s.url);
      const it = newItem(s.src, s.name, info, { x: 0, y: 0 });
      // 처음 넣을 때는 화면에 맞는 크기로 (원본 비율 유지)
      if (it.h > maxH) { const k = maxH / it.h; it.w *= k; it.h *= k; }
      it.cx = x + it.w / 2; it.cy = at.y + it.h / 2;
      x += it.w + Math.max(8, it.h * 0.03);
      added.push(it);
    } catch { failed++; }
  }
  if (!added.length) { if (failed) toast('이미지를 읽을 수 없습니다'); return; }
  pushUndo();
  B.items.push(...added);
  B.sel = new Set(added.map((i) => i.id));
  renderAll();
  if (B.items.length === added.length) fitAll();
  if (failed) toast(`${failed}개는 읽을 수 없어 건너뛰었습니다`);
}

async function addPaths(paths, screenPt) {
  const files = [];
  for (const p of paths) {
    const e = extOf(p);
    if (e === 'sref') { await openBoardFile(p); continue; }
    if (ALL_IMG.includes(e)) { files.push(p); continue; }
    // 폴더면 안의 이미지 전부
    try {
      const res = await inv('list_dir', { dir: p, imagesOnly: true });
      if (!res.error) res.images.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true })).forEach((im) => files.push(im.path));
    } catch {}
  }
  if (!files.length) return;
  const r = stage.getBoundingClientRect();
  const at = screenPt ? toWorld(screenPt.x, screenPt.y) : nextFreeSpot();
  await addSources(files.map((p) => ({ url: imgUrl(p), src: { path: p }, name: baseName(p) })), at);
}

function nextFreeSpot() {
  const b = unionBounds(B.items);
  if (!b) { const r = stage.getBoundingClientRect(); return toWorld(r.left + r.width * 0.1, r.top + r.height * 0.2); }
  return { x: b.x, y: b.y + b.h + Math.max(10, b.h * 0.03) };
}

async function addBlobs(files, screenPt) {
  const list = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const id = 'b' + blobSeq++;
    blobs.set(id, { blob: f, mime: f.type });
    list.push({ url: URL.createObjectURL(f), src: { blob: id }, name: f.name || '붙여넣은 이미지' });
  }
  if (!list.length) return;
  const at = screenPt ? toWorld(screenPt.x, screenPt.y) : nextFreeSpot();
  await addSources(list, at);
}

// ---------------- 편집 동작 ----------------
function removeSel() {
  if (!B.sel.size) return;
  pushUndo();
  B.items = B.items.filter((it) => !B.sel.has(it.id));
  B.sel.clear();
  renderAll();
}
function bringFront(ids) {
  const moving = B.items.filter((it) => ids.has(it.id));
  if (!moving.length) return;
  B.items = B.items.filter((it) => !ids.has(it.id)).concat(moving);
  renderAll();
}
function sendBack() {
  const moving = selItems();
  if (!moving.length) return;
  pushUndo();
  B.items = moving.concat(B.items.filter((it) => !B.sel.has(it.id)));
  renderAll();
}
const selImages = () => selItems().filter((it) => !isText(it));
function rotateSel(d) {
  const s = selImages(); if (!s.length) return;
  pushUndo();
  s.forEach((it) => { it.rot = ((it.rot + d) % 360 + 360) % 360; });
  renderAll();
}
function flipSel(axis) {
  const s = selImages(); if (!s.length) return;
  pushUndo();
  // 회전된 상태에서도 화면 기준으로 뒤집히도록
  s.forEach((it) => { const swap = it.rot % 180 !== 0; if ((axis === 'h') !== swap) it.fh = !it.fh; else it.fv = !it.fv; });
  renderAll();
}
function resetSel() {
  const s = selImages(); if (!s.length) return;
  pushUndo();
  s.forEach((it) => {
    const c = srcCache.get(it.id);
    const k = it.h / it.crop.h / (c ? c.nh : it.h); // 지금 배율 유지
    it.rot = 0; it.fh = false; it.fv = false;
    it.crop = { x: 0, y: 0, w: 1, h: 1 };
    if (c) { it.w = c.nw * k; it.h = c.nh * k; }
  });
  renderAll();
}
function matchSize(dim) {
  const s = selItems(); if (s.length < 2) return;
  pushUndo();
  const vals = s.map((it) => (dim === 'h' ? bounds(it).h : bounds(it).w)).sort((a, b) => a - b);
  const target = vals[Math.floor(vals.length / 2)];
  s.forEach((it) => { const cur = dim === 'h' ? bounds(it).h : bounds(it).w; const k = target / cur; it.w *= k; it.h *= k; });
  arrange(s, false);
}
// 자동 정렬: 줄 단위로 빈틈 없이 (PureRef의 Arrange)
function arrange(list = selItems().length > 1 ? selItems() : B.items, record = true) {
  if (!list.length) return;
  if (record) pushUndo();
  const start = unionBounds(list);
  const area = list.reduce((s, it) => { const b = bounds(it); return s + b.w * b.h; }, 0);
  const rowW = Math.max(Math.sqrt(area) * 1.4, Math.max(...list.map((it) => bounds(it).w)));
  const sorted = list.slice().sort((a, b) => bounds(b).h - bounds(a).h);
  const gap = Math.max(4, Math.min(...list.map((it) => bounds(it).h)) * 0.03);
  let x = start.x, y = start.y, rowH = 0;
  for (const it of sorted) {
    const b = bounds(it);
    if (x > start.x && x + b.w > start.x + rowW) { x = start.x; y += rowH + gap; rowH = 0; }
    it.cx = x + b.w / 2; it.cy = y + b.h / 2;
    x += b.w + gap; rowH = Math.max(rowH, b.h);
  }
  renderAll();
}

// ---------------- 텍스트 메모 ----------------
let editing = null; // 편집 중인 텍스트 id
function addText(screenPt) {
  const r = stage.getBoundingClientRect();
  const p = screenPt ? toWorld(screenPt.x, screenPt.y) : toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const last = store.textStyle;
  const it = {
    id: B.nextId++, type: 'text', text: '', name: '메모',
    cx: p.x, cy: p.y, w: 10, h: 10, fs: 28 / B.view.z,
    color: last.color, bg: last.bg, bold: last.bold,
    rot: 0, fh: false, fv: false, crop: { x: 0, y: 0, w: 1, h: 1 }
  };
  pushUndo();
  B.items.push(it);
  B.sel = new Set([it.id]);
  renderAll();
  startEdit(it, true);
}
function startEdit(it, isNew) {
  if (!it || !isText(it)) return;
  if (editing) finishEdit();
  if (!isNew) pushUndo();
  editing = it.id;
  const tx = it.el.firstChild;
  tx.setAttribute('contenteditable', 'true');
  tx.focus();
  const range = document.createRange(); range.selectNodeContents(tx);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  updateSelBox();
}
function finishEdit() {
  if (!editing) return;
  const it = byId(editing);
  editing = null;
  if (!it) return;
  const tx = it.el.firstChild;
  tx.removeAttribute('contenteditable');
  it.text = tx.innerText.replace(/\n$/, '');
  window.getSelection().removeAllRanges();
  if (!it.text.trim()) {
    B.items = B.items.filter((x) => x !== it);
    B.sel.delete(it.id);
  }
  renderAll();
  markDirty();
}
document.addEventListener('input', (e) => {
  if (!editing || !e.target.closest('.tx')) return;
  const it = byId(editing); if (!it) return;
  it.text = e.target.innerText;
  renderText(it); updateSelBox();
});
// 텍스트 꾸미기 (선택한 메모 전부)
const store = { get textStyle() { try { return JSON.parse(localStorage.getItem('sref.text')) || { color: '#ffffff', bg: 'transparent', bold: false }; } catch { return { color: '#ffffff', bg: 'transparent', bold: false }; } } };
function styleText(patch) {
  const s = selItems().filter(isText); if (!s.length) return;
  pushUndo();
  s.forEach((it) => {
    if (patch.fsMul) it.fs *= patch.fsMul;
    if (patch.color) it.color = patch.color;
    if (patch.bg) it.bg = patch.bg;
    if (patch.bold !== undefined) it.bold = patch.bold === 'toggle' ? !it.bold : patch.bold;
  });
  const f = s[0];
  try { localStorage.setItem('sref.text', JSON.stringify({ color: f.color, bg: f.bg, bold: f.bold })); } catch {}
  renderAll();
}

// ---------------- 자르기 ----------------
function startCrop(it) {
  if (!it || isText(it)) return;
  B.crop = it.id;
  B.sel = new Set([it.id]);
  stage.classList.add('crop');
  $('#cropHint').classList.remove('hidden');
  renderAll();
}
function endCrop() {
  B.crop = null;
  stage.classList.remove('crop');
  $('#cropHint').classList.add('hidden');
  updateSelBox();
}
// 화면 좌표 → 아이템 안 위치 (0~1, 지금 보이는 영역 기준)
function localUV(it, wx, wy) {
  let dx = wx - it.cx, dy = wy - it.cy;
  const r = -it.rot * Math.PI / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  let lx = dx * c - dy * s, ly = dx * s + dy * c;
  if (it.fh) lx = -lx;
  if (it.fv) ly = -ly;
  return { u: Math.min(1, Math.max(0, lx / it.w + 0.5)), v: Math.min(1, Math.max(0, ly / it.h + 0.5)) };
}
// 아이템 안 위치(0~1) → world 좌표
function uvToWorld(it, u, v) {
  let lx = (u - 0.5) * it.w, ly = (v - 0.5) * it.h;
  if (it.fh) lx = -lx;
  if (it.fv) ly = -ly;
  const r = it.rot * Math.PI / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  return { x: it.cx + lx * c - ly * s, y: it.cy + lx * s + ly * c };
}
function applyCrop(it, a, b) {
  const u1 = Math.min(a.u, b.u), u2 = Math.max(a.u, b.u), v1 = Math.min(a.v, b.v), v2 = Math.max(a.v, b.v);
  if (u2 - u1 < 0.01 || v2 - v1 < 0.01) return;
  pushUndo();
  const mid = uvToWorld(it, (u1 + u2) / 2, (v1 + v2) / 2);
  const c = it.crop;
  it.crop = { x: c.x + u1 * c.w, y: c.y + v1 * c.h, w: (u2 - u1) * c.w, h: (v2 - v1) * c.h };
  it.w *= (u2 - u1); it.h *= (v2 - v1);
  it.cx = mid.x; it.cy = mid.y;
  renderAll();
}
function resetCrop() {
  const s = selImages().filter((it) => it.crop.w < 1 || it.crop.h < 1); if (!s.length) return;
  pushUndo();
  for (const it of s) {
    const c = it.crop;
    const mid = uvToWorld(it, (0.5 - c.x) / c.w, (0.5 - c.y) / c.h);
    it.w /= c.w; it.h /= c.h;
    it.crop = { x: 0, y: 0, w: 1, h: 1 };
    it.cx = mid.x; it.cy = mid.y;
  }
  renderAll();
}

// ---------------- 마우스 ----------------
let drag = null;
let spaceDown = false;

stage.addEventListener('pointerdown', (e) => {
  hideMenu();
  if (editing && e.target.closest('.tx[contenteditable="true"]')) return;
  if (editing) finishEdit();
  downPt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  const wpt = toWorld(e.clientX, e.clientY);
  // 화면 이동: 가운데 버튼 또는 Space+왼쪽
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: B.view.x, vy: B.view.y };
    stage.classList.add('panning');
    stage.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button !== 0) return;
  // 자르기
  if (B.crop) {
    const it = byId(B.crop);
    if (!it) { endCrop(); return; }
    drag = { kind: 'crop', it, a: localUV(it, wpt.x, wpt.y), sx: e.clientX, sy: e.clientY };
    stage.setPointerCapture(e.pointerId);
    return;
  }
  // 크기 조절 손잡이
  const h = e.target.closest('#selbox .h');
  if (h) {
    const b = unionBounds(selItems());
    const corner = h.classList[1];
    const ax = corner.includes('w') ? b.x + b.w : b.x, ay = corner.includes('n') ? b.y + b.h : b.y;
    pushUndo();
    drag = {
      kind: 'scale', ax, ay, d0: Math.hypot(wpt.x - ax, wpt.y - ay) || 1,
      orig: selItems().map((it) => ({ it, cx: it.cx, cy: it.cy, w: it.w, h: it.h, fs: it.fs }))
    };
    stage.setPointerCapture(e.pointerId);
    return;
  }
  const itemEl = e.target.closest('.item');
  if (itemEl) {
    const id = +itemEl.dataset.id;
    if (e.ctrlKey || e.shiftKey) {
      if (B.sel.has(id)) B.sel.delete(id); else B.sel.add(id);
    } else if (!B.sel.has(id)) {
      B.sel = new Set([id]);
    }
    bringFront(B.sel.has(id) ? B.sel : new Set());
    drag = {
      kind: 'move', sx: wpt.x, sy: wpt.y, moved: false, clicked: id, plain: !(e.ctrlKey || e.shiftKey),
      orig: selItems().map((it) => ({ it, cx: it.cx, cy: it.cy }))
    };
    stage.setPointerCapture(e.pointerId);
    return;
  }
  // 빈 곳: 영역 선택
  if (!e.ctrlKey && !e.shiftKey) B.sel.clear();
  drag = { kind: 'rubber', sx: e.clientX, sy: e.clientY, base: new Set(B.sel) };
  renderAll();
  stage.setPointerCapture(e.pointerId);
});

stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const wpt = toWorld(e.clientX, e.clientY);
  if (drag.kind === 'pan') {
    B.view.x = drag.vx + (e.clientX - drag.sx);
    B.view.y = drag.vy + (e.clientY - drag.sy);
    applyView();
  } else if (drag.kind === 'move') {
    const dx = wpt.x - drag.sx, dy = wpt.y - drag.sy;
    if (!drag.moved && Math.hypot(dx * B.view.z, dy * B.view.z) < 3) return;
    if (!drag.moved) { drag.moved = true; pushUndo(); }
    drag.orig.forEach((o) => { o.it.cx = o.cx + dx; o.it.cy = o.cy + dy; render(o.it); });
    updateSelBox();
  } else if (drag.kind === 'scale') {
    const f = Math.max(0.01, Math.hypot(wpt.x - drag.ax, wpt.y - drag.ay) / drag.d0);
    drag.orig.forEach((o) => {
      o.it.cx = drag.ax + (o.cx - drag.ax) * f; o.it.cy = drag.ay + (o.cy - drag.ay) * f;
      o.it.w = o.w * f; o.it.h = o.h * f;
      if (isText(o.it)) o.it.fs = Math.max(2, o.fs * f);
      render(o.it);
    });
    updateSelBox();
    scheduleHiRes();
  } else if (drag.kind === 'rubber' || drag.kind === 'crop') {
    const r = stage.getBoundingClientRect();
    const x1 = Math.min(drag.sx, e.clientX) - r.left, y1 = Math.min(drag.sy, e.clientY) - r.top;
    const rb = $('#rubber');
    rb.style.display = 'block';
    rb.style.left = x1 + 'px'; rb.style.top = y1 + 'px';
    rb.style.width = Math.abs(e.clientX - drag.sx) + 'px'; rb.style.height = Math.abs(e.clientY - drag.sy) + 'px';
    if (drag.kind === 'rubber') {
      const a = toWorld(Math.min(drag.sx, e.clientX), Math.min(drag.sy, e.clientY));
      const b = toWorld(Math.max(drag.sx, e.clientX), Math.max(drag.sy, e.clientY));
      const next = new Set(drag.base);
      for (const it of B.items) {
        const bb = bounds(it);
        if (bb.x < b.x && bb.x + bb.w > a.x && bb.y < b.y && bb.y + bb.h > a.y) next.add(it.id);
      }
      B.sel = next;
      B.items.forEach((it) => it.el && it.el.classList.toggle('sel', B.sel.has(it.id)));
      updateSelBox();
    }
  }
});

function endDrag(e) {
  if (!drag) return;
  // 여러 장 선택 중 하나를 그냥 클릭(끌지 않음)하면 그 한 장만 선택
  if (drag.kind === 'move' && !drag.moved && drag.plain && B.sel.size > 1) {
    B.sel = new Set([drag.clicked]);
    renderAll();
  }
  if (drag.kind === 'crop') {
    const wpt = toWorld(e.clientX, e.clientY);
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) applyCrop(drag.it, drag.a, localUV(drag.it, wpt.x, wpt.y));
    endCrop();
  }
  $('#rubber').style.display = 'none';
  stage.classList.remove('panning');
  drag = null;
  updateSelBox();
}
stage.addEventListener('pointerup', (e) => { const wasCrop = B.crop; endDrag(e); if (!wasCrop && !spaceDown) checkDouble(e); downPt = null; });
stage.addEventListener('pointercancel', endDrag);

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const d = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
  if (e.ctrlKey) { setOpacity(B.opacity + (d < 0 ? 0.05 : -0.05)); return; }
  zoomAt(Math.pow(1.0015, -d), e.clientX, e.clientY);
}, { passive: false });

// 더블클릭: 이미지가 맨 앞으로 오면서 요소 순서가 바뀌면 브라우저가 더블클릭으로 안 쳐 주므로 직접 판단
let downPt = null, lastClick = null;
// 버튼을 뗄 때: 움직이지 않은 클릭이 0.4초 안에 같은 자리에서 두 번이면 더블클릭
function checkDouble(e) {
  if (!downPt || e.button !== 0 || Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 4) { lastClick = null; return; }
  const now = performance.now();
  if (lastClick && now - lastClick.t < 400 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6) {
    lastClick = null;
    onDouble(e);
  } else lastClick = { t: now, x: e.clientX, y: e.clientY };
}
function onDouble(e) {
  if (B.crop) return;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const itemEl = under && under.closest('.item');
  if (itemEl) {
    const it = byId(+itemEl.dataset.id);
    if (!it) return;
    if (isText(it)) startEdit(it); else fitTo(bounds(it), 0.03);
  } else fitAll();
}

// ---------------- 오른쪽 클릭 메뉴 ----------------
let menuPt = null;
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (editing) finishEdit();
  menuPt = { x: e.clientX, y: e.clientY };
  const itemEl = e.target.closest('.item');
  if (itemEl && !B.sel.has(+itemEl.dataset.id)) { B.sel = new Set([+itemEl.dataset.id]); renderAll(); }
  const has = B.sel.size > 0, multi = B.sel.size > 1, one = B.sel.size === 1 && !isText(selItems()[0]);
  const hasImg = selImages().length > 0, hasText = selItems().some(isText);
  const cropped = selItems().some((it) => it.crop.w < 1 || it.crop.h < 1);
  const op = Math.round(B.opacity * 100);
  showMenu(e.clientX, e.clientY, [
    ['이미지 열기…', '', () => pickImages()],
    ['붙여넣기', 'Ctrl+V', pasteFromClipboard],
    ['텍스트 메모 추가', 'Ctrl+T', () => addText(menuPt)],
    null,
    ['전체 보기', 'F', fitAll],
    ['자동 정렬', 'Ctrl+P', () => arrange()],
    null,
    ['이미지', '', [
      ['오른쪽으로 회전', 'R', () => rotateSel(90), !has],
      ['왼쪽으로 회전', 'Shift+R', () => rotateSel(-90), !has],
      ['좌우 뒤집기', 'H', () => flipSel('h'), !has],
      ['상하 뒤집기', 'Shift+H', () => flipSel('v'), !has],
      null,
      ['자르기', 'C', () => startCrop(selItems()[0]), !one],
      ['자르기 원래대로', 'Shift+C', resetCrop, !cropped],
      ['원래 모습으로', '', resetSel, !has],
      null,
      ['높이 맞추기', '', () => matchSize('h'), !multi],
      ['너비 맞추기', '', () => matchSize('w'), !multi],
      ['맨 뒤로 보내기', '', sendBack, !has]
    ], !hasImg],
    ['텍스트', '', [
      ['글 고치기', 'Enter', () => startEdit(selItems().find(isText)), !hasText],
      ['굵게 / 보통', '', () => styleText({ bold: 'toggle' })],
      ['글자 크게', '', () => styleText({ fsMul: 1.25 })],
      ['글자 작게', '', () => styleText({ fsMul: 0.8 })],
      null,
      ...Object.entries(TEXT_COLORS).map(([n, c]) => ['글자색: ' + n, '', () => styleText({ color: c })]),
      null,
      ...Object.entries(TEXT_BGS).map(([n, c]) => ['배경: ' + n, '', () => styleText({ bg: c })])
    ], !hasText],
    ['복사', 'Ctrl+C', copySel, !(B.sel.size === 1)],
    ['삭제', 'Delete', removeSel, !has],
    null,
    ['보기', '', [
      [(B.gray ? '✓ ' : '') + '회색조', 'G', toggleGray],
      [(B.onTop ? '✓ ' : '') + '항상 위', 'T', toggleOnTop],
      null,
      ['투명도 100%', '', () => setOpacity(1)],
      ['투명도 80%', '', () => setOpacity(0.8)],
      ['투명도 60%', '', () => setOpacity(0.6)],
      ['투명도 40%', 'Ctrl+휠', () => setOpacity(0.4)]
    ]],
    ['파일', '', [
      ['새 보드', '', newBoard],
      ['보드 열기…', 'Ctrl+O', openBoardDialog],
      ['저장', 'Ctrl+S', () => saveBoard(false)],
      ['다른 이름으로 저장…', 'Ctrl+Shift+S', () => saveBoard(true)]
    ]],
    null,
    ['Sweet picView 열기', '', () => inv('show_main')],
    ['도움말', 'F1', () => $('#help').classList.remove('hidden')]
  ]);
});

function buildMenu(items) {
  const m = document.createElement('div');
  m.className = 'menu';
  for (const it of items) {
    if (!it) { const s = document.createElement('div'); s.className = 'ms'; m.appendChild(s); continue; }
    const d = document.createElement('div');
    const sub = Array.isArray(it[2]);
    d.className = 'mi' + (it[3] ? ' off' : '') + (sub ? ' sub' : '');
    d.innerHTML = '<span></span><span class="k"></span>';
    d.firstChild.textContent = it[0];
    d.lastChild.textContent = sub ? '▸' : it[1];
    if (sub) {
      d.addEventListener('mouseenter', () => openSub(d, it[2]));
    } else {
      d.addEventListener('mouseenter', () => closeSub(m));
      if (it[2]) d.onclick = () => { hideMenu(); it[2](); };
    }
    m.appendChild(d);
  }
  return m;
}
function place(m, x, y) {
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
}
function closeSub(parent) {
  document.querySelectorAll('.menu.child').forEach((c) => { if (c.dataset.level > parent.dataset.level) c.remove(); });
}
function openSub(row, items) {
  const parent = row.parentElement;
  closeSub(parent);
  const m = buildMenu(items);
  m.classList.add('child');
  m.dataset.level = +parent.dataset.level + 1;
  document.body.appendChild(m);
  const r = row.getBoundingClientRect();
  let x = r.right - 2;
  if (x + m.offsetWidth > innerWidth - 4) x = r.left - m.offsetWidth + 2;
  place(m, x, r.top - 4);
}
function showMenu(x, y, items) {
  hideMenu();
  const m = buildMenu(items);
  m.id = 'menu';
  m.dataset.level = 0;
  document.body.appendChild(m);
  place(m, x, y);
}
function hideMenu() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }
window.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) hideMenu(); });

// ---------------- 보기 설정 ----------------
function toggleGray() { B.gray = !B.gray; root.classList.toggle('gray', B.gray); toast(B.gray ? '회색조 보기' : '컬러 보기'); }
async function toggleOnTop() {
  B.onTop = !B.onTop;
  try { await W.setAlwaysOnTop(B.onTop); } catch {}
  $('#bPin').classList.toggle('on', B.onTop);
  toast(B.onTop ? '항상 위: 켬' : '항상 위: 끔');
}
// 창 전체 투명도 (Windows 기능). 화면 쪽 투명 처리는 쓰지 않는다 (잔상 문제)
let opT = 0;
function setOpacity(v) {
  B.opacity = Math.round(Math.max(0.15, Math.min(1, v)) * 100) / 100;
  clearTimeout(opT);
  opT = setTimeout(() => inv('set_window_opacity', { opacity: B.opacity }).catch(() => toast('이 환경에서는 투명도를 바꿀 수 없습니다')), 30);
  toast(`투명도 ${Math.round(B.opacity * 100)}%`, 900);
}

// ---------------- 키보드 ----------------
document.addEventListener('keydown', (e) => {
  if (!$('#dlg').classList.contains('hidden')) return;
  if (editing) {
    if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) { e.preventDefault(); finishEdit(); }
    return;
  }
  if (!$('#help').classList.contains('hidden')) { $('#help').classList.add('hidden'); e.preventDefault(); return; }
  if (document.querySelector('.menu') && e.key === 'Escape') { hideMenu(); return; }
  const k = e.key, low = k.length === 1 ? k.toLowerCase() : k, ctrl = e.ctrlKey || e.metaKey;
  if (k === ' ') { spaceDown = true; stage.classList.add('space'); e.preventDefault(); return; }
  if (ctrl && ['r', 'u', 'j', 'g', 'h', 'f', 'n', 'w'].includes(low)) e.preventDefault(); // 웹뷰 기본 단축키 막기
  if (k === 'F5' || k === 'F7') { e.preventDefault(); return; }
  if (k === 'Escape') { if (B.crop) endCrop(); else { B.sel.clear(); renderAll(); } hideMenu(); return; }
  if (ctrl && low === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && low === 'y') { e.preventDefault(); redo(); return; }
  if (ctrl && low === 'a') { e.preventDefault(); B.sel = new Set(B.items.map((i) => i.id)); renderAll(); return; }
  if (ctrl && low === 's') { e.preventDefault(); saveBoard(e.shiftKey); return; }
  if (ctrl && low === 'o') { e.preventDefault(); openBoardDialog(); return; }
  if (ctrl && low === 'p') { e.preventDefault(); arrange(); return; }
  if (ctrl && low === 'c') { e.preventDefault(); copySel(); return; }
  if (ctrl && low === 't') { e.preventDefault(); addText(lastPointer); return; }
  if (k === 'Enter' && B.sel.size === 1 && isText(selItems()[0])) { e.preventDefault(); startEdit(selItems()[0]); return; }
  if (ctrl) return; // Ctrl+V는 paste 이벤트에서
  if (k === 'Delete' || k === 'Backspace') { removeSel(); return; }
  if (k === 'F1' || k === '?') { e.preventDefault(); $('#help').classList.remove('hidden'); return; }
  if (low === 'f' || k === 'Home') { fitAll(); return; }
  if (low === 'r') { rotateSel(e.shiftKey ? -90 : 90); return; }
  if (low === 'h') { flipSel(e.shiftKey ? 'v' : 'h'); return; }
  if (low === 'c') { e.shiftKey ? resetCrop() : startCrop(selItems()[0]); return; }
  if (low === 'g') { toggleGray(); return; }
  if (low === 't') { toggleOnTop(); return; }
  if (k.startsWith('Arrow') && B.sel.size) {
    e.preventDefault();
    const step = (e.shiftKey ? 50 : 5) / B.view.z;
    pushUndo();
    selItems().forEach((it) => {
      if (k === 'ArrowLeft') it.cx -= step; if (k === 'ArrowRight') it.cx += step;
      if (k === 'ArrowUp') it.cy -= step; if (k === 'ArrowDown') it.cy += step;
    });
    renderAll();
  }
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; stage.classList.remove('space'); } });
$('#help').addEventListener('pointerdown', () => $('#help').classList.add('hidden'));

// ---------------- 붙여넣기 / 복사 / 끌어다 놓기 ----------------
let lastPointer = null;
stage.addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; });
document.addEventListener('paste', (e) => {
  if (editing) {
    e.preventDefault();
    const t = e.clipboardData?.getData('text/plain') || '';
    if (t) document.execCommand('insertText', false, t);
    return;
  }
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) { e.preventDefault(); addBlobs(files, lastPointer); return; }
  const items = Array.from(e.clipboardData?.items || []).filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (items.length) { e.preventDefault(); addBlobs(items, lastPointer); }
});
async function pasteFromClipboard() {
  try {
    const list = await navigator.clipboard.read();
    const files = [];
    for (const ci of list) for (const t of ci.types) if (t.startsWith('image/')) files.push(new File([await ci.getType(t)], '붙여넣은 이미지', { type: t }));
    if (files.length) addBlobs(files, lastPointer); else toast('클립보드에 이미지가 없습니다');
  } catch { toast('Ctrl+V로 붙여넣어 주세요'); }
}
async function copySel() {
  const it = selItems()[0]; if (!it) return;
  if (isText(it)) { try { await navigator.clipboard.writeText(it.text); toast('글자를 복사했습니다'); } catch {} return; }
  try {
    const c = srcCache.get(it.id);
    const im = await loadImg(c.full);
    const cv = document.createElement('canvas');
    const sw = c.nw * it.crop.w, sh = c.nh * it.crop.h;
    const rotated = it.rot % 180 !== 0;
    cv.width = rotated ? sh : sw; cv.height = rotated ? sw : sh;
    const ctx = cv.getContext('2d');
    ctx.translate(cv.width / 2, cv.height / 2);
    ctx.rotate(it.rot * Math.PI / 180);
    ctx.scale(it.fh ? -1 : 1, it.fv ? -1 : 1);
    ctx.drawImage(im, c.nw * it.crop.x, c.nh * it.crop.y, sw, sh, -sw / 2, -sh / 2, sw, sh);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('이미지를 복사했습니다');
  } catch { toast('복사하지 못했습니다'); }
}
async function pickImages() {
  const p = await inv('pick_open_file', { filter: '이미지', exts: ALL_IMG });
  if (p) addPaths([p]);
}

T.event.listen('tauri://drag-enter', () => stage.classList.add('dragover'));
T.event.listen('tauri://drag-leave', () => stage.classList.remove('dragover'));
T.event.listen('tauri://drag-drop', (e) => {
  stage.classList.remove('dragover');
  const pos = e.payload && e.payload.position;
  const sf = window.devicePixelRatio || 1;
  addPaths((e.payload && e.payload.paths) || [], pos ? { x: pos.x / sf, y: pos.y / sf } : null);
});
T.event.listen('board-add', (e) => { const p = e.payload || {}; if (p.file) openBoardFile(p.file); if (p.paths && p.paths.length) addPaths(p.paths); });

// ---------------- 보드 파일 (.sref) ----------------
// 형식: "SREF1\n" + JSON 길이(4바이트) + JSON + [이미지 길이(4바이트) + 이미지]...
const MAGIC = 'SREF1\n';

async function sourceBytes(it) {
  if (it.src.blob) { const b = blobs.get(it.src.blob); return { bytes: new Uint8Array(await b.blob.arrayBuffer()), mime: b.mime }; }
  const p = it.src.path, e = extOf(p);
  if (NATIVE.includes(e)) {
    const bytes = await inv('read_file', { path: p });
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon' }[e];
    return { bytes: new Uint8Array(bytes), mime };
  }
  const r = await fetch(imgUrl(p));            // 특수 형식은 변환된 이미지로 저장
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get('Content-Type') || 'image/png' };
}

async function saveBoard(asNew) {
  if (!B.items.length) { toast('보드가 비어 있습니다'); return false; }
  toast('저장 중…', 60000);
  try {
    const keys = new Map(); const parts = []; const metas = [];
    if (editing) finishEdit();
    for (const it of B.items) {
      if (isText(it)) continue;
      const key = it.src.blob || it.src.path;
      if (!keys.has(key)) {
        const { bytes, mime } = await sourceBytes(it);
        keys.set(key, parts.length);
        parts.push(bytes); metas.push({ mime, name: it.name });
      }
    }
    const json = JSON.stringify({
      version: 1, view: B.view, gray: B.gray,
      blobs: metas,
      items: B.items.map((it) => isText(it)
        ? { type: 'text', text: it.text, cx: it.cx, cy: it.cy, fs: it.fs, color: it.color, bg: it.bg, bold: !!it.bold }
        : { b: keys.get(it.src.blob || it.src.path), name: it.name, cx: it.cx, cy: it.cy, w: it.w, h: it.h, rot: it.rot, fh: it.fh, fv: it.fv, crop: it.crop })
    });
    const enc = new TextEncoder();
    const jb = enc.encode(json);
    const len = (n) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n, true); return a; };
    const blob = new Blob([enc.encode(MAGIC), len(jb.length), jb, ...parts.flatMap((p) => [len(p.length), p])]);
    const data = new Uint8Array(await blob.arrayBuffer());
    const name = B.file && !asNew ? baseName(B.file) : '레퍼런스.sref';
    let saved;
    if (B.file && !asNew) {
      saved = await inv('save_to_path', data, { headers: { 'x-path': encodeURIComponent(B.file) } });
    } else {
      saved = await inv('save_file', data, { headers: { 'x-name': encodeURIComponent(name), 'x-filter': encodeURIComponent('Sweet Ref 보드'), 'x-ext': 'sref' } });
    }
    if (!saved) { toast('저장을 취소했습니다'); return false; }
    B.file = saved; B.dirty = false; updateTitle();
    toast('저장했습니다');
    return true;
  } catch (err) { toast('저장 실패: ' + err, 4000); return false; }
}

async function openBoardDialog() {
  if (!(await confirmDiscard())) return;
  const p = await inv('pick_open_file', { filter: 'Sweet Ref 보드', exts: ['sref'] });
  if (p) openBoardFile(p, true);
}

async function openBoardFile(path, skipConfirm) {
  if (!skipConfirm && B.items.length && !(await confirmDiscard())) return;
  try {
    const buf = new Uint8Array(await inv('read_file', { path }));
    const dec = new TextDecoder();
    if (dec.decode(buf.slice(0, MAGIC.length)) !== MAGIC) throw new Error('Sweet Ref 보드 파일이 아닙니다');
    const dv = new DataView(buf.buffer, buf.byteOffset);
    let p = MAGIC.length;
    const jl = dv.getUint32(p, true); p += 4;
    const meta = JSON.parse(dec.decode(buf.slice(p, p + jl))); p += jl;
    const ids = [];
    for (const bm of meta.blobs) {
      const n = dv.getUint32(p, true); p += 4;
      const id = 'b' + blobSeq++;
      blobs.set(id, { blob: new Blob([buf.slice(p, p + n)], { type: bm.mime }), mime: bm.mime });
      p += n; ids.push(id);
    }
    clearBoard();
    const infos = await Promise.all(ids.map((id) => prepare(URL.createObjectURL(blobs.get(id).blob)).catch(() => null)));
    for (const d of meta.items) {
      if (d.type === 'text') {
        B.items.push({ id: B.nextId++, type: 'text', text: d.text || '', name: '메모', cx: d.cx, cy: d.cy, w: 10, h: 10, fs: d.fs || 24, color: d.color || '#ffffff', bg: d.bg || 'transparent', bold: !!d.bold, rot: 0, fh: false, fv: false, crop: { x: 0, y: 0, w: 1, h: 1 } });
        continue;
      }
      const info = infos[d.b]; if (!info) continue;
      const it = newItem({ blob: ids[d.b] }, d.name, info, { x: 0, y: 0 });
      Object.assign(it, { cx: d.cx, cy: d.cy, w: d.w, h: d.h, rot: d.rot || 0, fh: !!d.fh, fv: !!d.fv, crop: d.crop || { x: 0, y: 0, w: 1, h: 1 } });
      B.items.push(it);
    }
    B.gray = !!meta.gray; root.classList.toggle('gray', B.gray);
    B.file = path; B.dirty = false;
    renderAll();
    if (meta.view) { B.view = meta.view; applyView(); } else fitAll();
    updateTitle();
  } catch (err) { toast('열 수 없습니다: ' + (err.message || err), 4000); }
}

function clearBoard() {
  B.items = []; B.sel.clear(); B.undo = []; B.redo = [];
  world.replaceChildren();
  B.view = { x: 0, y: 0, z: 1 };
}
async function newBoard() {
  if (!(await confirmDiscard())) return;
  clearBoard(); B.file = null; B.dirty = false; renderAll(); applyView(); updateTitle();
}
async function confirmDiscard() {
  if (!B.dirty || !B.items.length) return true;
  const r = await ask('저장하지 않은 변경 사항이 있어요.<br>저장할까요?', [['저장', 'save', true], ['저장 안 함', 'discard'], ['취소', 'cancel']]);
  if (r === 'cancel') return false;
  if (r === 'save') return await saveBoard(false);
  return true;
}

// ---------------- 창 ----------------
$('#bPin').onclick = toggleOnTop;
$('#bViewer').onclick = () => inv('show_main');
$('#bMin').onclick = () => W.minimize();
$('#bMax').onclick = () => W.toggleMaximize();
$('#bClose').onclick = async () => { if (await confirmDiscard()) W.destroy(); };
W.onCloseRequested(async (ev) => { ev.preventDefault(); if (await confirmDiscard()) W.destroy(); }).catch(() => {});
// 마우스가 위쪽 가장자리에 오면 막대 보이기
window.addEventListener('pointermove', (e) => root.classList.toggle('barOn', e.clientY < 34 && !drag));
window.addEventListener('resize', () => updateSelBox());

// ---------------- 시작 ----------------
(async function init() {
  applyView(); updateTitle(); renderAll();
  try {
    const [paths, file] = await inv('board_take_pending');
    if (file) await openBoardFile(file, true);
    if (paths && paths.length) await addPaths(paths);
  } catch {}
})();

window.__board = { addText, startEdit, finishEdit, styleText, B, addPaths, addBlobs, arrange, fitAll, undo, redo, rotateSel, flipSel, startCrop, applyCrop, resetCrop, saveBoard, openBoardFile, matchSize, localUV, toWorld, toScreen, selItems, removeSel, setOpacity };
