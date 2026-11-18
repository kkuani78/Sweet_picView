// Sweet picView - 백엔드 (파일 읽기, 폴더 목록, 저장, 파일 연결)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod convert;
mod tools;
mod thumbs;
#[cfg(windows)]
mod wic;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const NATIVE_EXT: &[&str] = &["jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "svg", "avif", "ico"];

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}
fn is_image(p: &Path) -> bool {
    let e = ext_of(p);
    NATIVE_EXT.contains(&e.as_str()) || convert::needs_decode(&e)
}
fn skip_name(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$')
}
fn mtime_ms(md: &fs::Metadata) -> f64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[derive(Serialize)]
struct ImageEntry {
    name: String,
    path: String,
    size: u64,
    mtime: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    rel: Option<String>,
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct ListResult {
    path: String,
    dirs: Vec<DirEntry>,
    images: Vec<ImageEntry>,
    error: Option<String>,
}

#[derive(Serialize)]
struct Root {
    label: String,
    path: String,
    kind: String,
}

#[tauri::command]
fn get_roots(app: AppHandle) -> Vec<Root> {
    let mut roots = Vec::new();
    let pr = app.path();
    let special: Vec<(&str, Option<PathBuf>)> = vec![
        ("사진", pr.picture_dir().ok()),
        ("바탕화면", pr.desktop_dir().ok()),
        ("다운로드", pr.download_dir().ok()),
        ("문서", pr.document_dir().ok()),
        ("홈", pr.home_dir().ok()),
    ];
    for (label, p) in special {
        if let Some(p) = p {
            if p.is_dir() {
                roots.push(Root { label: label.into(), path: p.to_string_lossy().into(), kind: "special".into() });
            }
        }
    }
    #[cfg(windows)]
    for c in b'A'..=b'Z' {
        let d = format!("{}:\\", c as char);
        if Path::new(&d).exists() {
            roots.push(Root { label: d[..2].to_string(), path: d, kind: "drive".into() });
        }
    }
    #[cfg(not(windows))]
    roots.push(Root { label: "/".into(), path: "/".into(), kind: "drive".into() });
    roots
}

#[tauri::command]
async fn list_dir(dir: String, images_only: Option<bool>) -> ListResult {
    let mut res = ListResult { path: dir.clone(), dirs: vec![], images: vec![], error: None };
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) => {
            res.error = Some(e.to_string());
            return res;
        }
    };
    let images_only = images_only.unwrap_or(false);
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if skip_name(&name) {
            continue;
        }
        let path = ent.path();
        let md = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.is_dir() {
            if !images_only {
                res.dirs.push(DirEntry { name, path: path.to_string_lossy().into() });
            }
        } else if is_image(&path) {
            res.images.push(ImageEntry { name, path: path.to_string_lossy().into(), size: md.len(), mtime: mtime_ms(&md), rel: None });
        }
    }
    res.dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    res
}

#[tauri::command]
async fn list_recursive(dir: String) -> Vec<ImageEntry> {
    const MAX: usize = 20000;
    let root = PathBuf::from(&dir);
    let mut out = Vec::new();
    let mut stack = vec![(root.clone(), 0usize)];
    while let Some((d, depth)) = stack.pop() {
        if out.len() >= MAX || depth > 12 {
            continue;
        }
        let rd = match fs::read_dir(&d) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel = d.strip_prefix(&root).map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if skip_name(&name) {
                continue;
            }
            let path = ent.path();
            let md = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if md.is_dir() {
                stack.push((path, depth + 1));
            } else if is_image(&path) {
                out.push(ImageEntry { name, path: path.to_string_lossy().into(), size: md.len(), mtime: mtime_ms(&md), rel: Some(rel.clone()) });
                if out.len() >= MAX {
                    break;
                }
            }
        }
    }
    out
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_folder_for(app: AppHandle, start: Option<String>) -> Option<String> {
    let mut d = app.dialog().file();
    if let Some(s) = start { d = d.set_directory(s); }
    d.blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn parent_dir(p: String) -> Option<String> {
    Path::new(&p).parent().map(|x| x.to_string_lossy().to_string()).filter(|s| !s.is_empty() && *s != p)
}

fn header(req: &Request<'_>, key: &str) -> String {
    let raw = req.headers().get(key).and_then(|v| v.to_str().ok()).unwrap_or("");
    percent_encoding::percent_decode_str(raw).decode_utf8_lossy().to_string()
}

#[tauri::command]
async fn save_file(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let data = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        _ => return Err("잘못된 데이터".into()),
    };
    let name = header(&request, "x-name");
    let filter = header(&request, "x-filter");
    let ext = header(&request, "x-ext");
    let target: Option<PathBuf> = if let Ok(dir) = std::env::var("PICVIEW_TEST_OUT") {
        Some(PathBuf::from(dir).join(&name))
    } else {
        let mut dlg = app.dialog().file().set_file_name(&name).add_filter(&filter, &[ext.as_str()]);
        if let Ok(d) = app.path().desktop_dir() {
            dlg = dlg.set_directory(d);
        }
        dlg.blocking_save_file().and_then(|f| f.into_path().ok())
    };
    match target {
        None => Ok(None),
        Some(t) => {
            fs::write(&t, data).map_err(|e| e.to_string())?;
            Ok(Some(t.to_string_lossy().to_string()))
        }
    }
}

/// 정해진 경로에 바로 저장 (보드 다시 저장). 임시 파일에 쓴 뒤 바꿔치기
#[tauri::command]
async fn save_to_path(request: Request<'_>) -> Result<Option<String>, String> {
    let data = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        _ => return Err("잘못된 데이터".into()),
    };
    let path = header(&request, "x-path");
    if path.is_empty() {
        return Err("경로가 없습니다".into());
    }
    let tmp = PathBuf::from(format!("{path}.spvtmp"));
    fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(Some(path))
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(p: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_in_folder(p: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_default_apps() -> Result<(), String> {
    tauri_plugin_opener::open_url("ms-settings:defaultapps", None::<&str>).map_err(|e| e.to_string())
}

// ---------- 업데이트 (GitHub 릴리스) ----------
#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let u = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(u.map(|u| UpdateInfo { version: u.version.clone(), current: u.current_version.clone(), notes: u.body.clone() }))
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let u = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("이미 최신 버전입니다")?;
    let mut got: u64 = 0;
    let app2 = app.clone();
    u.download_and_install(
        move |chunk, total| {
            got += chunk as u64;
            let _ = app2.emit("update-progress", (got, total.unwrap_or(0)));
        },
        || {},
    )
    .await
    .map_err(|e| e.to_string())?;
    // Windows는 설치 프로그램이 실행되면서 앱이 닫히고, 설치 후 다시 켜진다
    app.restart();
}

struct LaunchPath(Mutex<Option<String>>);

// ---------- 레퍼런스 보드 (Sweet Ref) ----------
#[derive(Default)]
struct BoardPending(Mutex<(Vec<String>, Option<String>)>);

fn is_board_file(p: &str) -> bool {
    p.to_ascii_lowercase().ends_with(".sref")
}

fn create_board(app: &AppHandle, paths: Vec<String>, file: Option<String>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("board") {
        let _ = app.emit_to("board", "board-add", serde_json::json!({ "paths": paths, "file": file }));
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    if let Ok(mut g) = app.state::<BoardPending>().0.lock() {
        *g = (paths, file);
    }
    tauri::WebviewWindowBuilder::new(app, "board", tauri::WebviewUrl::App("board.html".into()))
        .title("Sweet Ref")
        .inner_size(960.0, 720.0)
        .min_inner_size(240.0, 160.0)
        .decorations(false)
        .transparent(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// PicView에서 보드 열기 (paths: 보낼 이미지, file: 열 .sref)
#[tauri::command]
async fn open_board(app: AppHandle, paths: Vec<String>, file: Option<String>) -> Result<(), String> {
    create_board(&app, paths, file)
}

#[tauri::command]
fn board_take_pending(state: tauri::State<BoardPending>) -> (Vec<String>, Option<String>) {
    state.0.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default()
}

/// 뷰어(메인) 창을 보이게. 닫혀서 없으면 새로 만든다. 새로 만들었으면 true
fn ensure_main(app: &AppHandle) -> Option<(tauri::WebviewWindow, bool)> {
    if let Some(w) = app.get_webview_window("main") {
        return Some((w, false));
    }
    let cfg = app.config().app.windows.iter().find(|w| w.label == "main").cloned()?;
    let w = tauri::WebviewWindowBuilder::from_config(app, &cfg).ok()?.build().ok()?;
    Some((w, true))
}

fn show_main_window(app: &AppHandle, file: Option<String>) {
    if let Some((w, created)) = ensure_main(app) {
        if let Some(p) = file {
            if created {
                // 새 창은 아직 화면이 준비 전이라, 켜질 때 가져가도록 맡겨 둔다
                if let Ok(mut g) = app.state::<LaunchPath>().0.lock() {
                    *g = Some(p);
                }
            } else {
                let _ = app.emit_to("main", "open-file", p);
            }
        }
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
async fn show_main(app: AppHandle) {
    show_main_window(&app, None);
}

#[tauri::command]
async fn pick_open_file(app: AppHandle, filter: String, exts: Vec<String>) -> Option<String> {
    let e: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    app.dialog()
        .file()
        .add_filter(&filter, &e)
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

fn file_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .find(|a| Path::new(a).exists())
}

#[tauri::command]
fn get_launch_path(state: tauri::State<LaunchPath>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

// 사진 정보(EXIF): [이름, 값] 목록
#[tauri::command]
async fn exif_info(path: String) -> Vec<(String, String)> {
    use exif::{In, Tag};
    let mut out = Vec::new();
    let file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return out,
    };
    let mut reader = std::io::BufReader::new(file);
    let ex = match exif::Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return out,
    };
    let tags: &[(Tag, &str)] = &[
        (Tag::DateTimeOriginal, "촬영 일시"),
        (Tag::Make, "제조사"),
        (Tag::Model, "카메라"),
        (Tag::LensModel, "렌즈"),
        (Tag::FocalLength, "초점 거리"),
        (Tag::FNumber, "조리개"),
        (Tag::ExposureTime, "셔터 속도"),
        (Tag::PhotographicSensitivity, "ISO"),
        (Tag::ExposureBiasValue, "노출 보정"),
        (Tag::Flash, "플래시"),
        (Tag::WhiteBalance, "화이트 밸런스"),
        (Tag::Software, "소프트웨어"),
        (Tag::Artist, "작성자"),
    ];
    for (tag, label) in tags {
        if let Some(f) = ex.get_field(*tag, In::PRIMARY) {
            let v = f.display_value().with_unit(&ex).to_string();
            let v = v.trim_matches('"').trim().to_string();
            if !v.is_empty() {
                out.push((label.to_string(), v));
            }
        }
    }
    out
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn main() {
    let launch_arg = file_arg(std::env::args());
    let board_file = launch_arg.clone().filter(|p| is_board_file(p));
    let launch = launch_arg.filter(|p| !is_board_file(p));
    std::thread::spawn(convert::clean_cache);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 이미 실행 중일 때 다른 이미지를 더블클릭하면 같은 창에서 연다
            let file = file_arg(args);
            if let Some(p) = &file {
                if is_board_file(p) {
                    let _ = create_board(app, vec![], Some(p.clone()));
                    return;
                }
            }
            // 이미지 더블클릭 또는 시작 메뉴 아이콘: 뷰어를 보이게 (닫혀 있으면 다시 만듦)
            let app = app.clone();
            tauri::async_runtime::spawn(async move { show_main_window(&app, file) });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(LaunchPath(Mutex::new(launch)))
        .manage(BoardPending::default())
        .setup(move |app| {
            if let Some(f) = board_file.clone() {
                // .sref를 더블클릭해서 켠 경우: 보드만 띄운다
                if let Some(m) = app.get_webview_window("main") {
                    let _ = m.hide();
                }
                let _ = create_board(app.handle(), vec![], Some(f));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 보드가 열려 있을 때 뷰어를 닫으면 숨기기만 (나중에 다시 불러올 수 있게)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && window.app_handle().get_webview_window("board").is_some() {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
            }
            // 메인 창이 숨겨진 상태에서 보드를 닫으면 프로그램 종료
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "board" {
                    let app = window.app_handle();
                    match app.get_webview_window("main") {
                        Some(m) => {
                            if !m.is_visible().unwrap_or(true) {
                                app.exit(0);
                            }
                        }
                        None => app.exit(0),
                    }
                }
            }
        })
        // localimg://localhost/<경로>  →  실제 이미지 파일
        .register_asynchronous_uri_scheme_protocol("localimg", |_ctx, request, responder| {
            let raw = request.uri().path().trim_start_matches('/').to_string();
            std::thread::spawn(move || {
                let p = percent_encoding::percent_decode_str(&raw).decode_utf8_lossy().to_string();
                let path = PathBuf::from(&p);
                let ext = ext_of(&path);
                let result = if convert::needs_decode(&ext) {
                    convert::get(&path, &ext)
                } else {
                    fs::read(&path).map(|b| (b, mime_for(&ext))).map_err(|e| e.to_string())
                };
                let resp = match result {
                    Ok((bytes, mime)) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cache-Control", "max-age=3600")
                        .body(bytes)
                        .unwrap(),
                    Err(err) => tauri::http::Response::builder()
                        .status(415)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Expose-Headers", "X-Error")
                        .header("X-Error", percent_encoding::utf8_percent_encode(&err, percent_encoding::NON_ALPHANUMERIC).to_string())
                        .body(Vec::new())
                        .unwrap(),
                };
                responder.respond(resp);
            });
        })
        // thumb://localhost/<경로>  →  작은 썸네일 JPEG (X-W, X-H: 원본 크기)
        .register_asynchronous_uri_scheme_protocol("thumb", |_ctx, request, responder| {
            let raw = request.uri().path().trim_start_matches('/').to_string();
            std::thread::spawn(move || {
                let p = percent_encoding::percent_decode_str(&raw).decode_utf8_lossy().to_string();
                let resp = match thumbs::get(Path::new(&p)) {
                    Ok(t) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", "image/jpeg")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Expose-Headers", "X-W, X-H")
                        .header("X-W", t.w.to_string())
                        .header("X-H", t.h.to_string())
                        .header("Cache-Control", "max-age=3600")
                        .body(t.jpeg)
                        .unwrap(),
                    Err(_) => tauri::http::Response::builder()
                        .status(415)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new())
                        .unwrap(),
                };
                responder.respond(resp);
            });
        })
        .invoke_handler(tauri::generate_handler![
            get_roots,
            list_dir,
            list_recursive,
            pick_folder,
            parent_dir,
            save_file,
            save_to_path,
            read_file,
            open_path,
            show_in_folder,
            open_default_apps,
            get_launch_path,
            exif_info,
            pick_folder_for,
            app_version,
            open_board,
            board_take_pending,
            show_main,
            pick_open_file,
            check_update,
            install_update,
            tools::resize_images,
            tools::rename_files,
            tools::transfer_files
        ])
        .run(tauri::generate_context!())
        .expect("Sweet picView 실행 오류");
}
