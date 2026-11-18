/* Sweet picView - 일괄 리사이즈 / 일괄 이름 바꾸기 */
'use strict';

const tool = { mode: null, items: [], busy: false, unlisten: null };

function toolTargets() {
  let items = selectedItems();
  let note = '';
  if (!items.length) {
    items = state.view.slice();
    note = ' <span class="warn-txt">(선택한 이미지가 없어 화면의 전체 이미지가 대상입니다)</span>';
  }
  return { items, note };
}

function openTool(mode, title, okLabel, html) {
  tool.mode = mode;
  $('#toolTitle').textContent = title;
  $('#toolOk').textContent = okLabel;
  $('#toolBody').innerHTML = html;
  $('#toolMsg').textContent = ''; $('#toolMsg').className = 'tool-msg';
  $('#toolProgress').classList.add('hidden');
  setToolBusy(false);
  $('#toolModal').classList.remove('hidden');
}
function closeTool() { if (tool.busy) return; $('#toolModal').classList.add('hidden'); gridWrap.focus(); }
function setToolBusy(b) { tool.busy = b; $('#toolOk').disabled = b; $('#toolCancel').disabled = b; }
function toolMsg(t, err) { const m = $('#toolMsg'); m.textContent = t || ''; m.className = 'tool-msg' + (err ? ' err' : ''); }

$('#toolClose').onclick = closeTool;
$('#toolCancel').onclick = closeTool;
$('#toolModal').addEventListener('mousedown', (e) => { if (e.target.id === 'toolModal') closeTool(); });
$('#toolOk').onclick = () => (tool.mode === 'resize' ? runResize() : runRename());
document.addEventListener('keydown', (e) => {
  if ($('#toolModal').classList.contains('hidden')) return;
  if (e.key === 'Escape') closeTool();
  if (e.key === 'Enter' && e.target.tagName !== 'SELECT' && !tool.busy) { e.preventDefault(); $('#toolOk').click(); }
});
$('#btnResize').onclick = () => openResize();
$('#btnRename').onclick = () => openRename();

// ======================= 리사이즈 =======================
function openResize() {
  if (!state.view.length) { toast('먼저 이미지가 있는 폴더를 여세요.', { error: true }); return; }
  const { items, note } = toolTargets();
  tool.items = items;
  const o = store.get('resizeOpt', {});
  const r = (v, cur) => (v === (cur || 'long') ? 'checked' : '');
  openTool('resize', '↔ 이미지 크기 바꾸기', '크기 바꾸기', `
    <div class="target">대상: <b>${items.length.toLocaleString()}장</b>${note}</div>
    <div class="trow"><span class="tl">크기 기준</span>
      <label class="radio"><input type="radio" name="rmode" value="percent" ${r('percent', o.mode)}> 비율</label>
      <label class="radio"><input type="radio" name="rmode" value="long" ${r('long', o.mode)}> 긴 변</label>
      <label class="radio"><input type="radio" name="rmode" value="width" ${r('width', o.mode)}> 가로</label>
      <label class="radio"><input type="radio" name="rmode" value="height" ${r('height', o.mode)}> 세로</label>
      <label class="radio"><input type="radio" name="rmode" value="fit" ${r('fit', o.mode)}> 가로×세로 안에 맞추기</label>
    </div>
    <div class="trow"><span class="tl">크기</span>
      <span id="rzPercent">비율 <input class="tin" type="number" id="rzPct" min="1" max="1000" value="${o.percent || 50}"> %</span>
      <span id="rzLong">긴 변 <input class="tin" type="number" id="rzLongV" min="1" value="${o.long || 1920}"> px</span>
      <span id="rzW">가로 <input class="tin" type="number" id="rzWidth" min="1" value="${o.width || 1920}"> px</span>
      <span id="rzH">세로 <input class="tin" type="number" id="rzHeight" min="1" value="${o.height || 1080}"> px</span>
      <label class="chk"><input type="checkbox" id="rzNoUp" ${o.noUpscale === false ? '' : 'checked'}> 원본보다 크게 키우지 않기</label>
    </div>
    <div class="trow"><span class="tl">저장 형식</span>
      <select id="rzFmt" class="sel">
        <option value="same">원본 형식 유지</option><option value="jpg">JPG</option><option value="png">PNG</option>
      </select>
      <span id="rzQWrap">JPG 품질 <input type="range" id="rzQ" min="50" max="100" value="${o.quality || 90}"> <b id="rzQv">${o.quality || 90}</b></span>
    </div>
    <div class="trow"><span class="tl">저장 위치</span>
      <label class="radio"><input type="radio" name="rout" value="subfolder" ${o.output !== 'folder' && o.output !== 'overwrite' ? 'checked' : ''}> 하위 폴더</label>
      <input class="tin" id="rzSub" value="${esc(o.subfolder || 'resized')}">
      <label class="radio"><input type="radio" name="rout" value="folder" ${o.output === 'folder' ? 'checked' : ''}> 다른 폴더</label>
      <button class="btn" id="rzPick">선택…</button><span id="rzFolder" class="pnote">${esc(o.folder || '')}</span>
    </div>
    <div class="trow"><span class="tl"></span>
      <label class="radio"><input type="radio" name="rout" value="overwrite" ${o.output === 'overwrite' ? 'checked' : ''}> 원본에 덮어쓰기</label>
      <span class="warn-txt">⚠ 원본 파일이 바뀌며 되돌릴 수 없습니다</span>
    </div>
    <div class="trow"><span class="tl">파일 이름 뒤에</span>
      <input class="tin wide" id="rzSuffix" value="${esc(o.suffix ?? '')}" placeholder="예: _small (비워도 됨)">
    </div>
    <div class="pwrap"><table class="ptable"><thead><tr><th>파일</th><th>지금 크기</th><th></th><th>바뀔 크기</th></tr></thead><tbody id="rzPreview"></tbody></table></div>
    <div class="pnote">· RAW 파일은 카메라에 들어 있는 미리보기 이미지를 기준으로 만들어집니다. · 사진 정보(EXIF)는 새 파일에 저장되지 않습니다.</div>
  `);
  tool.folder = o.folder || '';
  $('#rzFmt').value = o.format || 'same';
  $('#rzPick').onclick = async () => {
    const f = await api.pickFolderFor(tool.folder || state.folder);
    if (f) { tool.folder = f; $('#rzFolder').textContent = f; document.querySelector('input[name=rout][value=folder]').checked = true; syncResize(); }
  };
  $('#toolBody').querySelectorAll('input,select').forEach((el) => { el.addEventListener('input', syncResize); el.addEventListener('change', syncResize); });
  syncResize();
  ensureDims(items.slice(0, 60)).then(() => { if (tool.mode === 'resize') syncResize(); });
}

function readResize() {
  const mode = document.querySelector('input[name=rmode]:checked').value;
  return {
    mode,
    percent: Math.max(1, +$('#rzPct').value || 50),
    long: Math.max(1, Math.round(+$('#rzLongV').value || 1)),
    width: Math.max(1, Math.round(+$('#rzWidth').value || 1)),
    height: Math.max(1, Math.round(+$('#rzHeight').value || 1)),
    noUpscale: $('#rzNoUp').checked,
    format: $('#rzFmt').value,
    quality: +$('#rzQ').value,
    output: document.querySelector('input[name=rout]:checked').value,
    subfolder: $('#rzSub').value.trim() || 'resized',
    folder: tool.folder || null,
    suffix: $('#rzSuffix').value
  };
}

function calcSize(w, h, o) {
  let s;
  if (o.mode === 'percent') s = o.percent / 100;
  else if (o.mode === 'long') s = o.long / Math.max(w, h);
  else if (o.mode === 'width') s = o.width / w;
  else if (o.mode === 'height') s = o.height / h;
  else s = Math.min(o.width / w, o.height / h);
  if (o.noUpscale) s = Math.min(1, s);
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function syncResize() {
  const o = readResize();
  store.set('resizeOpt', o);
  $('#rzPercent').style.display = o.mode === 'percent' ? '' : 'none';
  $('#rzLong').style.display = o.mode === 'long' ? '' : 'none';
  $('#rzW').style.display = ['width', 'fit'].includes(o.mode) ? '' : 'none';
  $('#rzH').style.display = ['height', 'fit'].includes(o.mode) ? '' : 'none';
  $('#rzQv').textContent = o.quality;
  $('#rzQWrap').style.opacity = o.format === 'png' ? '.35' : '1';
  $('#rzSub').disabled = o.output !== 'subfolder';
  const rows = tool.items.slice(0, 60).map((it) => {
    const r = state.rotation.get(it.path) || 0;
    if (!it.w) return `<tr><td>${esc(it.name)}</td><td>…</td><td class="arrow">→</td><td>…</td></tr>`;
    const [nw, nh] = calcSize(it.w, it.h, o);
    return `<tr><td>${esc(it.name)}</td><td>${it.w} × ${it.h}</td><td class="arrow">→</td><td class="new">${nw} × ${nh}</td></tr>`;
  });
  if (tool.items.length > 60) rows.push(`<tr><td colspan="4" class="pnote">… 외 ${tool.items.length - 60}장</td></tr>`);
  $('#rzPreview').innerHTML = rows.join('');
  if (o.output === 'folder' && !tool.folder) toolMsg('저장할 폴더를 선택하세요.');
  else if (o.output === 'overwrite') toolMsg('원본 파일을 덮어씁니다. 되돌릴 수 없어요.', true);
  else toolMsg('');
}

async function runResize() {
  if (tool.busy) return;
  const o = readResize();
  if (o.output === 'folder' && !tool.folder) { toolMsg('저장할 폴더를 선택하세요.', true); return; }
  const paths = tool.items.map((x) => x.path);
  setToolBusy(true);
  $('#toolProgress').classList.remove('hidden');
  const setP = (d, t) => { $('#toolBar').style.width = (d / t * 100) + '%'; $('#toolText').textContent = `${d} / ${t}`; };
  setP(0, paths.length);
  const un = await api.onResizeProgress(setP);
  let res = [];
  try { res = await api.resizeImages(paths, o); }
  catch (err) { toolMsg('오류: ' + err, true); }
  finally { try { un(); } catch {} }
  setToolBusy(false);
  const ok = res.filter((r) => r.out);
  const bad = res.filter((r) => !r.out);
  window.__lastResize = res;
  if (!res.length) return;
  closeTool();
  const outDir = ok.length ? ok[0].out.slice(0, ok[0].out.length - baseName(ok[0].out).length).replace(/[\\/]$/, '') : null;
  let msg = `크기 바꾸기 완료: <b>${ok.length}장</b>`;
  if (bad.length) msg += `<br><span style="color:#ff7b72">실패 ${bad.length}장</span><br><span style="font-size:12px;color:#a3a9b5">${bad.slice(0, 3).map((b) => esc(baseName(b.path) + ': ' + b.error)).join('<br>')}</span>`;
  const actions = [];
  if (outDir) actions.push({ label: '결과 폴더 열기', run: () => openFolder(outDir) });
  toast(msg, { ms: 14000, error: !ok.length, actions });
  // 덮어썼거나 현재 폴더에 저장된 경우 목록 새로고침
  if (o.output === 'overwrite' || outDir === state.folder) {
    for (const r of ok) { thumbCache.delete(r.path); thumbCache.delete(r.out); }
    await reloadKeepSelection(new Map());
  } else if (o.output === 'subfolder') {
    refreshTreeNode(state.folder);
  }
}

// ======================= 이름 바꾸기 =======================
function openRename() {
  if (!state.view.length) { toast('먼저 이미지가 있는 폴더를 여세요.', { error: true }); return; }
  const { items, note } = toolTargets();
  tool.items = items;
  const o = store.get('renameOpt', {});
  openTool('rename', '✎ 파일 이름 바꾸기', '이름 바꾸기', `
    <div class="target">대상: <b>${items.length.toLocaleString()}개</b> (지금 화면의 정렬 순서대로 번호가 매겨집니다)${note}</div>
    <div class="trow"><span class="tl">기본 이름</span>
      <label class="radio"><input type="radio" name="rnBase" value="keep" ${o.base !== 'new' ? 'checked' : ''}> 원래 이름 유지</label>
      <label class="radio"><input type="radio" name="rnBase" value="new" ${o.base === 'new' ? 'checked' : ''}> 새 이름</label>
      <input class="tin wide" id="rnNew" value="${esc(o.newName || '')}" placeholder="예: 촬영본">
    </div>
    <div class="trow"><span class="tl">프리픽스</span>
      <input class="tin wide" id="rnPre" value="${esc(o.prefix || '')}" placeholder="앞에 붙일 글자 (예: 2026_)">
      <span class="tl" style="width:auto;margin-left:14px">포스트픽스</span>
      <input class="tin wide" id="rnPost" value="${esc(o.postfix || '')}" placeholder="뒤에 붙일 글자 (예: _v2)">
    </div>
    <div class="trow"><span class="tl">번호 매기기</span>
      <label class="chk"><input type="checkbox" id="rnNum" ${o.num ? 'checked' : ''}> 리넘버링</label>
      시작 <input class="tin" type="number" id="rnStart" value="${o.start ?? 1}" style="width:70px">
      증가 <input class="tin" type="number" id="rnStep" value="${o.step ?? 1}" style="width:60px">
      자릿수 <select id="rnDigits" class="sel">${[1, 2, 3, 4, 5, 6].map((d) => `<option value="${d}">${d} (${'0'.repeat(d - 1)}1)</option>`).join('')}</select>
      위치 <select id="rnPos" class="sel"><option value="after">이름 뒤</option><option value="before">이름 앞</option></select>
      구분자 <input class="tin" id="rnSep" value="${esc(o.sep ?? '_')}" style="width:50px">
    </div>
    <div class="trow"><span class="tl">확장자</span>
      <select id="rnExt" class="sel"><option value="keep">그대로</option><option value="lower">소문자로 (.JPG → .jpg)</option><option value="upper">대문자로</option></select>
      <span class="pnote" id="rnSample"></span>
    </div>
    <div class="pwrap"><table class="ptable"><thead><tr><th>지금 이름</th><th></th><th>바뀔 이름</th></tr></thead><tbody id="rnPreview"></tbody></table></div>
  `);
  $('#rnDigits').value = o.digits || 3;
  $('#rnPos').value = o.pos || 'after';
  $('#rnExt').value = o.ext || 'keep';
  $('#toolBody').querySelectorAll('input,select').forEach((el) => { el.addEventListener('input', syncRename); el.addEventListener('change', syncRename); });
  $('#rnNew').addEventListener('focus', () => { document.querySelector('input[name=rnBase][value=new]').checked = true; syncRename(); });
  syncRename();
}

function readRename() {
  return {
    base: document.querySelector('input[name=rnBase]:checked').value,
    newName: $('#rnNew').value,
    prefix: $('#rnPre').value,
    postfix: $('#rnPost').value,
    num: $('#rnNum').checked,
    start: Math.round(+$('#rnStart').value || 0),
    step: Math.round(+$('#rnStep').value || 1),
    digits: +$('#rnDigits').value,
    pos: $('#rnPos').value,
    sep: $('#rnSep').value,
    ext: $('#rnExt').value
  };
}

const BAD_NAME = /[\\/:*?"<>|]/;
function dirOf(p) { return p.slice(0, p.length - baseName(p).length); }

function buildNames(o) {
  return tool.items.map((it, i) => {
    const dot = it.name.lastIndexOf('.');
    const stem = dot > 0 ? it.name.slice(0, dot) : it.name;
    let ext = dot > 0 ? it.name.slice(dot) : '';
    if (o.ext === 'lower') ext = ext.toLowerCase(); else if (o.ext === 'upper') ext = ext.toUpperCase();
    let base = o.base === 'new' ? o.newName : stem;
    if (o.num) {
      const n = o.start + i * o.step;
      const num = (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(o.digits, '0');
      base = !base ? num : o.pos === 'before' ? num + o.sep + base : base + o.sep + num;
    }
    return o.prefix + base + o.postfix + ext;
  });
}

function checkNames(names) {
  // 같은 폴더 안 중복, 기존 파일과 겹침, 잘못된 문자 검사
  const srcSet = new Set(tool.items.map((x) => x.path.toLowerCase()));
  const existing = new Set(state.all.map((x) => x.path.toLowerCase()));
  const seen = new Map();
  return names.map((nm, i) => {
    const it = tool.items[i];
    const stem = nm.replace(/\.[^.]*$/, '');
    if (!stem.trim()) return '이름이 비어 있음';
    if (BAD_NAME.test(nm)) return '쓸 수 없는 문자 \\ / : * ? " < > |';
    const full = (dirOf(it.path) + nm).toLowerCase();
    if (seen.has(full)) return '같은 이름이 중복됨';
    seen.set(full, i);
    if (existing.has(full) && !srcSet.has(full)) return '이미 있는 파일 이름';
    return null;
  });
}

function syncRename() {
  const o = readRename();
  store.set('renameOpt', o);
  $('#rnNew').disabled = o.base !== 'new';
  ['#rnStart', '#rnStep', '#rnDigits', '#rnPos', '#rnSep'].forEach((s) => ($(s).disabled = !o.num));
  if (o.base === 'new' && !o.newName && !o.num) toolMsg('새 이름을 쓰거나 번호 매기기를 켜세요.');
  const names = buildNames(o);
  const errs = checkNames(names);
  tool.names = names; tool.errs = errs;
  const nBad = errs.filter(Boolean).length;
  const nChange = names.filter((n, i) => n !== tool.items[i].name).length;
  const rows = tool.items.slice(0, 300).map((it, i) => {
    const cls = errs[i] ? 'bad' : names[i] === it.name ? 'same' : '';
    return `<tr class="${cls}"><td>${esc(it.name)}</td><td class="arrow">→</td><td class="new">${esc(names[i])}${errs[i] ? ` <span>(${esc(errs[i])})</span>` : ''}</td></tr>`;
  });
  if (tool.items.length > 300) rows.push(`<tr><td colspan="3" class="pnote">… 외 ${tool.items.length - 300}개</td></tr>`);
  $('#rnPreview').innerHTML = rows.join('');
  $('#rnSample').textContent = names[0] ? `예: ${names[0]}` : '';
  if (nBad) toolMsg(`문제가 있는 이름 ${nBad}개 — 고친 뒤에 바꿀 수 있어요.`, true);
  else if (!nChange) toolMsg('바뀌는 이름이 없습니다.');
  else toolMsg(`${nChange}개의 이름이 바뀝니다.`);
  $('#toolOk').disabled = tool.busy || !!nBad || !nChange;
}

async function runRename() {
  if (tool.busy) return;
  syncRename();
  if (tool.errs.some(Boolean)) return;
  const pairs = tool.items.map((it, i) => [it.path, tool.names[i]]).filter((p, i) => p[1] !== tool.items[i].name);
  if (!pairs.length) return;
  setToolBusy(true);
  let done;
  try { done = await api.renameFiles(pairs); }
  catch (err) { setToolBusy(false); toolMsg('이름을 바꾸지 못했습니다: ' + err, true); return; }
  setToolBusy(false);
  closeTool();
  const map = new Map(done.map(([a, b]) => [a, b]));
  moveCaches(map);
  await reloadKeepSelection(map);
  window.__lastRename = done;
  toast(`이름 바꾸기 완료: <b>${done.length}개</b>`, {
    ms: 15000,
    actions: [{ label: '되돌리기', run: () => undoRename(done) }]
  });
}

async function undoRename(done) {
  const back = done.map(([a, b]) => [b, baseName(a)]);
  try {
    const r = await api.renameFiles(back);
    const map = new Map(r.map(([a, b]) => [a, b]));
    moveCaches(map);
    await reloadKeepSelection(map);
    toast('이름을 원래대로 되돌렸습니다.');
  } catch (err) { toast('되돌리기 실패: ' + esc(String(err)), { error: true }); }
}

// 경로가 바뀐 파일의 썸네일/회전 정보 옮기기
function moveCaches(map) {
  for (const [a, b] of map) {
    if (thumbCache.has(a)) { thumbCache.set(b, thumbCache.get(a)); thumbCache.delete(a); }
    if (state.rotation.has(a)) { state.rotation.set(b, state.rotation.get(a)); state.rotation.delete(a); }
  }
}

// 폴더를 다시 읽고 선택 상태 유지
async function reloadKeepSelection(map) {
  const sel = new Set([...state.selected].map((p) => map.get(p) || p));
  const top = gridWrap.scrollTop;
  await openFolder(state.folder);
  state.view.forEach((x) => { if (sel.has(x.path)) state.selected.add(x.path); });
  refreshSelClasses();
  gridWrap.scrollTop = top;
}

function refreshTreeNode() { /* 폴더 트리는 다음에 펼칠 때 갱신됨 */ }
