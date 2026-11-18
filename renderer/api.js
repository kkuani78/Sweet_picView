// 화면 ↔ 백엔드(Tauri) 연결
(function () {
  const T = window.__TAURI__;
  const inv = (cmd, args, opts) => T.core.invoke(cmd, args, opts);
  window.api = {
    getRoots: () => inv('get_roots'),
    listDir: (dir, opts) => inv('list_dir', { dir, imagesOnly: !!(opts && opts.imagesOnly) }),
    listRecursive: (dir) => inv('list_recursive', { dir }),
    pickFolder: () => inv('pick_folder'),
    parentDir: (p) => inv('parent_dir', { p }),
    saveFile: (data, name, filterName, ext) => inv('save_file', data, {
      headers: { 'x-name': encodeURIComponent(name), 'x-filter': encodeURIComponent(filterName), 'x-ext': ext }
    }),
    readFile: async (p) => new Uint8Array(await inv('read_file', { path: p })),
    openPath: (p) => inv('open_path', { p }),
    showInFolder: (p) => inv('show_in_folder', { p }),
    openDefaultApps: () => inv('open_default_apps'),
    getLaunchPath: () => inv('get_launch_path'),
    exif: (p) => inv('exif_info', { path: p }),
    imgUrl: (p) => T.core.convertFileSrc(p, 'localimg'),
    onOpenFile: (cb) => T.event.listen('open-file', (e) => cb(e.payload)),
    onDrop: (onDrop, onHover) => {
      T.event.listen('tauri://drag-drop', (e) => { onHover(false); onDrop((e.payload && e.payload.paths) || []); });
      T.event.listen('tauri://drag-enter', () => onHover(true));
      T.event.listen('tauri://drag-leave', () => onHover(false));
    },
    isWindows: /Windows/i.test(navigator.userAgent)
  };
})();
