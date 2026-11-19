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
    appVersion: () => inv('app_version'),
    checkUpdate: () => inv('check_update'),
    installUpdate: () => inv('install_update'),
    onUpdateProgress: (cb) => T.event.listen('update-progress', (e) => cb(e.payload[0], e.payload[1])),
    exif: (p) => inv('exif_info', { path: p }),
    pickFolderFor: (start) => inv('pick_folder_for', { start: start || null }),
    resizeImages: (paths, opts) => inv('resize_images', { paths, opts }),
    renameFiles: (pairs) => inv('rename_files', { pairs }),
    transferFiles: (paths, dest, mode, conflict) => inv('transfer_files', { paths, dest, mode, conflict }),
    onTransferProgress: (cb) => T.event.listen('transfer-progress', (e) => cb(e.payload[0], e.payload[1])),
    startDrag: (paths) => inv('start_drag_files', { paths }),
    openBoard: (paths, file) => inv('open_board', { paths: paths || [], file: file || null }),
    onResizeProgress: (cb) => T.event.listen('resize-progress', (e) => cb(e.payload[0], e.payload[1])),
    imgUrl: (p) => T.core.convertFileSrc(p, 'localimg'),
    thumbUrl: (p) => T.core.convertFileSrc(p, 'thumb'),
    onOpenFile: (cb) => T.event.listen('open-file', (e) => cb(e.payload)),
    onDrop: (onDrop, onHover) => {
      T.event.listen('tauri://drag-drop', (e) => { onHover(false); onDrop((e.payload && e.payload.paths) || []); });
      T.event.listen('tauri://drag-enter', () => onHover(true));
      T.event.listen('tauri://drag-leave', () => onHover(false));
    },
    isWindows: /Windows/i.test(navigator.userAgent)
  };
})();
