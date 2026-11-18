// Sweet picView - 백엔드 (파일 읽기, 폴더 목록, 저장, 파일 연결)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod convert;
mod tools;
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

struct LaunchPath(Mutex<Option<String>>);

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
    let launch = file_arg(std::env::args());
    std::thread::spawn(convert::clean_cache);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 이미 실행 중일 때 다른 이미지를 더블클릭하면 같은 창에서 연다
            if let Some(p) = file_arg(args) {
                let _ = app.emit("open-file", p);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchPath(Mutex::new(launch)))
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
        .invoke_handler(tauri::generate_handler![
            get_roots,
            list_dir,
            list_recursive,
            pick_folder,
            parent_dir,
            save_file,
            read_file,
            open_path,
            show_in_folder,
            open_default_apps,
            get_launch_path,
            exif_info,
            pick_folder_for,
            tools::resize_images,
            tools::rename_files
        ])
        .run(tauri::generate_context!())
        .expect("Sweet picView 실행 오류");
}
