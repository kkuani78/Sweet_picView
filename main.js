// PicView - 메인 프로세스 (창, 파일 접근, 저장, 인쇄 담당)
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { pathToFileURL } = require('url');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico']);
const TEST_OUT = process.env.PICVIEW_TEST_OUT || null; // 자동 테스트용 (저장 대화상자 생략)

protocol.registerSchemesAsPrivileged([
  { scheme: 'localimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }
]);

let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1b1d22',
    title: 'PicView',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  Menu.setApplicationMenu(null);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWin.webContents.toggleDevTools();
  });
}

app.whenReady().then(() => {
  // localimg://f/<인코딩된 경로>  →  실제 파일
  protocol.handle('localimg', async (req) => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname.slice(1));
    const res = await net.fetch(pathToFileURL(p).toString());
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(res.body, { status: res.status, headers });
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ---------- 폴더 / 파일 ----------
ipcMain.handle('get-roots', async () => {
  const roots = [];
  const add = (label, p, kind) => { try { if (p && fs.existsSync(p)) roots.push({ label, path: p, kind }); } catch {} };
  add('사진', app.getPath('pictures'), 'special');
  add('바탕화면', app.getPath('desktop'), 'special');
  add('다운로드', app.getPath('downloads'), 'special');
  add('문서', app.getPath('documents'), 'special');
  add('홈', app.getPath('home'), 'special');
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(d)) roots.push({ label: d.slice(0, 2), path: d, kind: 'drive' }); } catch {}
    }
  } else {
    roots.push({ label: '/', path: '/', kind: 'drive' });
  }
  return roots;
});

ipcMain.handle('list-dir', async (_e, dir, opts = {}) => {
  const result = { path: dir, dirs: [], images: [], error: null };
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (err) { result.error = err.message; return result; }
  const imgs = [];
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.') || name.startsWith('$')) continue;
    const full = path.join(dir, name);
    if (ent.isDirectory()) {
      if (!opts.imagesOnly) result.dirs.push({ name, path: full });
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      if (IMAGE_EXT.has(path.extname(name).toLowerCase())) imgs.push({ name, path: full });
    }
  }
  await Promise.all(imgs.map(async (it) => {
    try { const st = await fsp.stat(it.path); it.size = st.size; it.mtime = st.mtimeMs; }
    catch { it.size = 0; it.mtime = 0; }
  }));
  result.images = imgs;
  result.dirs.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  return result;
});

// 하위 폴더까지 이미지 수집 (최대 깊이 제한)
ipcMain.handle('list-recursive', async (_e, dir, maxFiles = 20000) => {
  const out = [];
  async function walk(d, depth) {
    if (out.length >= maxFiles || depth > 12) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name.startsWith('$')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(full, depth + 1);
      else if (IMAGE_EXT.has(path.extname(ent.name).toLowerCase())) {
        try { const st = await fsp.stat(full); out.push({ name: ent.name, path: full, size: st.size, mtime: st.mtimeMs, rel: path.relative(dir, d) }); }
        catch {}
      }
      if (out.length >= maxFiles) return;
    }
  }
  await walk(dir, 0);
  return out;
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('parent-dir', (_e, p) => {
  const parent = path.dirname(p);
  return parent === p ? null : parent;
});

ipcMain.handle('save-file', async (_e, data, defaultName, filterName, ext) => {
  let target;
  if (TEST_OUT) target = path.join(TEST_OUT, defaultName);
  else {
    const r = await dialog.showSaveDialog(mainWin, {
      defaultPath: path.join(app.getPath('desktop'), defaultName),
      filters: [{ name: filterName, extensions: [ext] }]
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  await fsp.writeFile(target, Buffer.from(data));
  return target;
});

ipcMain.handle('read-file', async (_e, p) => new Uint8Array(await fsp.readFile(p)));
ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

// ---------- 인쇄 ----------
// html: 인쇄용 문서, opts: { pageSize, landscape, toPdf, pdfName }
ipcMain.handle('print-html', async (_e, html, opts) => {
  const tmp = path.join(os.tmpdir(), `picview-print-${Date.now()}.html`);
  await fsp.writeFile(tmp, html, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  try {
    await win.loadFile(tmp);
    // 이미지가 모두 로드될 때까지 대기
    await win.webContents.executeJavaScript(`
      Promise.all(Array.from(document.images).map(img => img.complete ? 0 :
        new Promise(r => { img.onload = img.onerror = r; })))
        .then(() => document.images.length)
    `);
    if (opts.toPdf) {
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        margins: { marginType: 'none' }
      });
      let target;
      if (TEST_OUT) target = path.join(TEST_OUT, opts.pdfName || 'print.pdf');
      else {
        const r = await dialog.showSaveDialog(mainWin, {
          defaultPath: path.join(app.getPath('desktop'), opts.pdfName || '인쇄.pdf'),
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });
        if (r.canceled || !r.filePath) return { ok: false, canceled: true };
        target = r.filePath;
      }
      await fsp.writeFile(target, pdf);
      return { ok: true, path: target };
    }
    const res = await new Promise((resolve) => {
      win.webContents.print({
        silent: false,
        printBackground: true,
        landscape: !!opts.landscape,
        pageSize: opts.pageSize || 'A4',
        margins: { marginType: 'none' }
      }, (success, reason) => resolve({ ok: success, reason }));
    });
    return res;
  } finally {
    setTimeout(() => { try { win.destroy(); } catch {} fsp.unlink(tmp).catch(() => {}); }, 1500);
  }
});
