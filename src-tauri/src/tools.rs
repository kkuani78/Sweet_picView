// 일괄 리사이즈 / 일괄 이름 바꾸기
use crate::convert;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// 편집용으로 이미지 전체를 읽는다 (EXIF 회전 반영)
pub fn load_for_edit(path: &Path) -> Result<DynamicImage, String> {
    let ext = ext_of(path);
    if convert::needs_decode(&ext) {
        return convert::decode_full(path, &ext).map(DynamicImage::ImageRgba8);
    }
    if matches!(ext.as_str(), "svg" | "avif") {
        return Err(format!("{} 형식은 크기를 바꿀 수 없습니다", ext.to_uppercase()));
    }
    let reader = image::ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
    let mut dec = reader.into_decoder().map_err(|e| e.to_string())?;
    let orient = dec.orientation().ok();
    let mut img = DynamicImage::from_decoder(dec).map_err(|e| e.to_string())?;
    if let Some(o) = orient {
        img.apply_orientation(o);
    }
    Ok(img)
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResizeOpts {
    mode: String, // percent | long | width | height | fit
    percent: f64,
    long: u32,
    width: u32,
    height: u32,
    no_upscale: bool,
    format: String, // same | jpg | png
    quality: u8,
    output: String, // subfolder | folder | overwrite
    subfolder: String,
    folder: Option<String>,
    suffix: String,
}

#[derive(Serialize)]
pub struct ResizeResult {
    path: String,
    out: Option<String>,
    error: Option<String>,
    w: u32,
    h: u32,
}

fn target_size(w: u32, h: u32, o: &ResizeOpts) -> (u32, u32) {
    let (w, h) = (w as f64, h as f64);
    let s = match o.mode.as_str() {
        "percent" => o.percent / 100.0,
        "long" => o.long as f64 / w.max(h),
        "width" => o.width as f64 / w,
        "height" => o.height as f64 / h,
        _ => (o.width as f64 / w).min(o.height as f64 / h),
    };
    let s = if o.no_upscale { s.min(1.0) } else { s };
    (((w * s).round() as u32).max(1), ((h * s).round() as u32).max(1))
}

fn flatten_white(img: &RgbaImage) -> image::RgbImage {
    image::RgbImage::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y).0;
        let a = p[3] as u32;
        let f = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        image::Rgb([f(p[0]), f(p[1]), f(p[2])])
    })
}

fn out_ext(src_ext: &str, o: &ResizeOpts, has_alpha: bool) -> &'static str {
    match o.format.as_str() {
        "jpg" => "jpg",
        "png" => "png",
        _ => match src_ext {
            "jpg" | "jpeg" | "jfif" => "jpg",
            "png" => "png",
            "bmp" => "bmp",
            "tif" | "tiff" => "tif",
            "tga" => "tga",
            "gif" => "gif",
            "webp" => "webp",
            _ => if has_alpha { "png" } else { "jpg" },
        },
    }
}

fn save(img: &DynamicImage, path: &Path, ext: &str, quality: u8) -> Result<(), String> {
    let mut buf = Vec::new();
    let mut cur = std::io::Cursor::new(&mut buf);
    match ext {
        "jpg" => {
            let rgb = flatten_white(&img.to_rgba8());
            let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cur, quality.clamp(10, 100));
            rgb.write_with_encoder(enc).map_err(|e| e.to_string())?;
        }
        "png" => img.write_to(&mut cur, ImageFormat::Png).map_err(|e| e.to_string())?,
        "bmp" => DynamicImage::ImageRgb8(flatten_white(&img.to_rgba8())).write_to(&mut cur, ImageFormat::Bmp).map_err(|e| e.to_string())?,
        "tif" => img.write_to(&mut cur, ImageFormat::Tiff).map_err(|e| e.to_string())?,
        "tga" => img.write_to(&mut cur, ImageFormat::Tga).map_err(|e| e.to_string())?,
        "gif" => img.write_to(&mut cur, ImageFormat::Gif).map_err(|e| e.to_string())?,
        "webp" => DynamicImage::ImageRgba8(img.to_rgba8()).write_to(&mut cur, ImageFormat::WebP).map_err(|e| e.to_string())?,
        _ => return Err("저장할 수 없는 형식".into()),
    }
    // 임시 파일에 먼저 쓰고 바꿔치기 (덮어쓰기 중 오류로 원본이 망가지지 않게)
    let tmp = path.with_extension(format!("{ext}.spvtmp"));
    fs::write(&tmp, &buf).map_err(|e| e.to_string())?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| { let _ = fs::remove_file(&tmp); e.to_string() })
}

fn unique(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image").to_string();
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    for n in 2..10000 {
        let c = dir.join(format!("{stem} ({n}).{ext}"));
        if !c.exists() {
            return c;
        }
    }
    path
}

pub fn resize_one(src: &Path, opts: &ResizeOpts) -> Result<(String, u32, u32), String> {
    let img = load_for_edit(src)?;
    let (w, h) = img.dimensions();
    let (tw, th) = target_size(w, h, opts);
    let out_img = if (tw, th) == (w, h) { img } else { img.resize_exact(tw, th, image::imageops::FilterType::Lanczos3) };
    let has_alpha = out_img.color().has_alpha() && out_img.to_rgba8().pixels().any(|px| px.0[3] < 255);
    let ext = out_ext(&ext_of(src), opts, has_alpha);
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let dir = src.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    let name = format!("{stem}{}.{ext}", opts.suffix);
    let target = match opts.output.as_str() {
        "overwrite" => dir.join(&name),
        "folder" => {
            let f = PathBuf::from(opts.folder.clone().unwrap_or_default());
            fs::create_dir_all(&f).map_err(|e| e.to_string())?;
            unique(f.join(&name))
        }
        _ => {
            let sub = if opts.subfolder.trim().is_empty() { "resized".to_string() } else { opts.subfolder.trim().to_string() };
            let f = dir.join(sub);
            fs::create_dir_all(&f).map_err(|e| e.to_string())?;
            unique(f.join(&name))
        }
    };
    save(&out_img, &target, ext, opts.quality)?;
    Ok((target.to_string_lossy().to_string(), tw, th))
}

#[tauri::command]
pub async fn resize_images(app: AppHandle, paths: Vec<String>, opts: ResizeOpts) -> Vec<ResizeResult> {
    let total = paths.len();
    let mut results = Vec::with_capacity(total);
    for (i, p) in paths.iter().enumerate() {
        let src = PathBuf::from(p);
        let r = resize_one(&src, &opts);
        match r {
            Ok((out, w, h)) => results.push(ResizeResult { path: p.clone(), out: Some(out), error: None, w, h }),
            Err(e) => results.push(ResizeResult { path: p.clone(), out: None, error: Some(e), w: 0, h: 0 }),
        }
        let _ = app.emit("resize-progress", (i + 1, total));
    }
    results
}

// ---------------- 이름 바꾸기 ----------------
const BAD_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// pairs: [원래 경로, 새 파일 이름]. 성공하면 [원래 경로, 새 경로] 목록
#[tauri::command]
pub async fn rename_files(pairs: Vec<(String, String)>) -> Result<Vec<(String, String)>, String> {
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
    let sources: HashSet<String> = pairs.iter().map(|(s, _)| s.to_lowercase()).collect();
    let mut targets: HashSet<String> = HashSet::new();
    for (src, new_name) in &pairs {
        let name = new_name.trim();
        if name.is_empty() || name.starts_with('.') {
            return Err(format!("빈 이름이 있습니다: {src}"));
        }
        if name.contains(BAD_CHARS) {
            return Err(format!("파일 이름에 쓸 수 없는 문자가 있습니다: {name}"));
        }
        let s = PathBuf::from(src);
        let t = s.parent().map(|d| d.join(name)).ok_or("잘못된 경로")?;
        let tl = t.to_string_lossy().to_lowercase();
        if !targets.insert(tl.clone()) {
            return Err(format!("같은 이름이 두 번 나옵니다: {name}"));
        }
        if t.exists() && !sources.contains(&tl) {
            return Err(format!("이미 있는 파일과 이름이 겹칩니다: {name}"));
        }
        if s != t {
            plan.push((s, t));
        }
    }
    // 1단계: 임시 이름으로, 2단계: 최종 이름으로 (서로 이름을 맞바꾸는 경우도 안전)
    let mut temps: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::new();
    for (i, (s, t)) in plan.iter().enumerate() {
        let tmp = s.with_file_name(format!(".spv_rename_{}_{i}", std::process::id()));
        if let Err(e) = fs::rename(s, &tmp) {
            for (s0, _, tmp0) in temps.iter().rev() {
                let _ = fs::rename(tmp0, s0);
            }
            return Err(format!("{} 이름을 바꿀 수 없습니다: {e}", s.display()));
        }
        temps.push((s.clone(), t.clone(), tmp));
    }
    let mut done = Vec::new();
    for (k, (s, t, tmp)) in temps.iter().enumerate() {
        if let Err(e) = fs::rename(tmp, t) {
            // 실패: 지금까지 바꾼 것 되돌리기
            for (s1, t1) in done.iter().rev() {
                let _ = fs::rename(PathBuf::from(t1 as &String), PathBuf::from(s1 as &String));
            }
            for (s2, _, tmp2) in temps[k..].iter() {
                let _ = fs::rename(tmp2, s2);
            }
            return Err(format!("{} 이름을 바꿀 수 없습니다: {e}", t.display()));
        }
        done.push((s.to_string_lossy().to_string(), t.to_string_lossy().to_string()));
    }
    Ok(done)
}


// ---------------- 이동 / 복사 ----------------
#[derive(Serialize)]
pub struct TransferResult {
    path: String,
    out: Option<String>,
    skipped: bool,
    error: Option<String>,
}

/// mode: "copy" | "move", conflict: "rename" | "skip" | "overwrite"
#[tauri::command]
pub async fn transfer_files<R: tauri::Runtime>(app: tauri::AppHandle<R>, paths: Vec<String>, dest: String, mode: String, conflict: String) -> Result<Vec<TransferResult>, String> {
    let dest = PathBuf::from(dest.trim());
    if dest.as_os_str().is_empty() {
        return Err("대상 폴더가 비어 있습니다".into());
    }
    fs::create_dir_all(&dest).map_err(|e| format!("폴더를 만들 수 없습니다: {e}"))?;
    let total = paths.len();
    let mut out = Vec::with_capacity(total);
    for (i, p) in paths.iter().enumerate() {
        let src = PathBuf::from(p);
        let r = (|| -> Result<(Option<String>, bool), String> {
            let name = src.file_name().ok_or("잘못된 경로")?;
            let mut target = dest.join(name);
            if target == src {
                return Ok((None, true)); // 같은 폴더로 이동/복사
            }
            if target.exists() {
                match conflict.as_str() {
                    "skip" => return Ok((None, true)),
                    "overwrite" => {
                        if target.is_dir() {
                            return Err("같은 이름의 폴더가 있습니다".into());
                        }
                    }
                    _ => target = unique(target),
                }
            }
            if mode == "move" {
                if fs::rename(&src, &target).is_err() {
                    // 다른 드라이브: 복사 후 원본 삭제
                    fs::copy(&src, &target).map_err(|e| e.to_string())?;
                    fs::remove_file(&src).map_err(|e| format!("복사는 됐지만 원본을 지우지 못했습니다: {e}"))?;
                }
            } else {
                fs::copy(&src, &target).map_err(|e| e.to_string())?;
            }
            Ok((Some(target.to_string_lossy().to_string()), false))
        })();
        out.push(match r {
            Ok((o, skipped)) => TransferResult { path: p.clone(), out: o, skipped, error: None },
            Err(e) => TransferResult { path: p.clone(), out: None, skipped: false, error: Some(e) },
        });
        let _ = app.emit("transfer-progress", (i + 1, total));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn opts(mode: &str, output: &str, format: &str) -> ResizeOpts {
        ResizeOpts { mode: mode.into(), percent: 50.0, long: 300, width: 200, height: 200, no_upscale: true,
            format: format.into(), quality: 85, output: output.into(), subfolder: "resized".into(), folder: None, suffix: "_s".into() }
    }
    #[test]
    fn resize_and_rename() {
        let dir = std::env::temp_dir().join(format!("spv_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = std::env::var("SAMPLES").unwrap_or("/home/claude/fmt".into());
        for f in ["ref.jpg", "ref.png", "sample.psd", "sample_maya.iff", "sample.exr", "sample.cr2"] {
            fs::copy(Path::new(&src).join(f), dir.join(f)).unwrap();
        }
        // 리사이즈
        for (f, mode, fmt) in [("ref.jpg", "percent", "same"), ("ref.png", "long", "same"), ("sample.psd", "width", "same"),
                               ("sample_maya.iff", "fit", "jpg"), ("sample.exr", "height", "png"), ("sample.cr2", "long", "same")] {
            let r = resize_one(&dir.join(f), &opts(mode, "subfolder", fmt)).unwrap();
            let (w, h) = image::image_dimensions(&r.0).unwrap();
            println!("resize {f} [{mode},{fmt}] -> {} {w}x{h}", Path::new(&r.0).file_name().unwrap().to_string_lossy());
            assert_eq!((w, h), (r.1, r.2));
        }
        // 덮어쓰기
        let r = resize_one(&dir.join("ref.jpg"), &ResizeOpts { suffix: "".into(), ..opts("percent", "overwrite", "same") }).unwrap();
        assert_eq!(image::image_dimensions(dir.join("ref.jpg")).unwrap(), (320, 200));
        println!("overwrite -> {}", r.0);
        // 이름 바꾸기: 서로 맞바꾸기 + 번호
        fs::write(dir.join("a.png"), b"A").unwrap();
        fs::write(dir.join("b.png"), b"B").unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();
        let rt = tauri::async_runtime::block_on(rename_files(vec![(p("a.png"), "b.png".into()), (p("b.png"), "a.png".into())])).unwrap();
        assert_eq!(fs::read(dir.join("a.png")).unwrap(), b"B");
        println!("swap ok {:?}", rt.len());
        // 이미 있는 파일과 겹치면 거부
        let e = tauri::async_runtime::block_on(rename_files(vec![(p("a.png"), "ref.png".into())]));
        println!("conflict -> {:?}", e.err());
        let e = tauri::async_runtime::block_on(rename_files(vec![(p("a.png"), "x?.png".into())]));
        println!("bad char -> {:?}", e.err());
        let rt = tauri::async_runtime::block_on(rename_files(vec![(p("a.png"), "proj_001_v2.png".into()), (p("b.png"), "proj_002_v2.png".into())])).unwrap();
        assert!(dir.join("proj_001_v2.png").exists() && !dir.join("a.png").exists());
        println!("renumber ok {:?}", rt);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn transfer() {
        let dir = std::env::temp_dir().join(format!("spv_tr_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("dst")).unwrap();
        for n in ["a.jpg", "b.jpg"] { fs::write(dir.join(n), n.as_bytes()).unwrap(); }
        fs::write(dir.join("dst/a.jpg"), b"old").unwrap();
        let app = tauri::test::mock_app();
        let p = |n: &str| dir.join(n).to_string_lossy().to_string();
        let run = |mode: &str, conflict: &str, dest: &str| tauri::async_runtime::block_on(transfer_files(app.handle().clone(), vec![p("a.jpg"), p("b.jpg")], p(dest), mode.into(), conflict.into())).unwrap();
        let r = run("copy", "rename", "dst");
        println!("copy+rename: {:?}", r.iter().map(|x| x.out.clone()).collect::<Vec<_>>());
        assert!(dir.join("dst/a (2).jpg").exists() && dir.join("a.jpg").exists());
        let r = run("copy", "skip", "dst");
        assert!(r[0].skipped && r[1].skipped);
        let r = run("move", "overwrite", "new_folder/sub");
        println!("move to new folder: {:?}", r.iter().map(|x| x.out.clone()).collect::<Vec<_>>());
        assert!(!dir.join("a.jpg").exists() && dir.join("new_folder/sub/a.jpg").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
