// 빠른 썸네일: Windows 탐색기 썸네일 → JPEG 축소 디코드 → 일반 디코드, 결과는 디스크에 캐시
use crate::convert;
use image::{imageops, DynamicImage, RgbImage, RgbaImage};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

pub const THUMB_MAX: u32 = 360;
const VERSION: u32 = 1;
const BG: [u8; 3] = [21, 23, 27]; // 썸네일 칸 배경색 (투명 부분)

pub struct Thumb {
    pub jpeg: Vec<u8>,
    pub w: u32, // 원본 가로 (모르면 0)
    pub h: u32,
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

fn cache_path(path: &Path) -> Option<PathBuf> {
    let md = fs::metadata(path).ok()?;
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    md.len().hash(&mut h);
    md.modified().ok()?.hash(&mut h);
    VERSION.hash(&mut h);
    THUMB_MAX.hash(&mut h);
    Some(std::env::temp_dir().join("sweetpicview-cache").join("thumbs").join(format!("{:016x}.jpg", h.finish())))
}

pub fn get(path: &Path) -> Result<Thumb, String> {
    let cp = cache_path(path);
    if let Some(c) = &cp {
        if let Ok(b) = fs::read(c) {
            // 캐시 파일 끝 8바이트에 원본 크기 저장
            if b.len() > 8 {
                let n = b.len() - 8;
                let w = u32::from_le_bytes(b[n..n + 4].try_into().unwrap());
                let h = u32::from_le_bytes(b[n + 4..].try_into().unwrap());
                return Ok(Thumb { jpeg: b[..n].to_vec(), w, h });
            }
        }
    }
    let p = path.to_path_buf();
    let t = std::panic::catch_unwind(move || make(&p)).map_err(|_| "썸네일 오류".to_string())??;
    if let Some(c) = cp {
        let _ = fs::create_dir_all(c.parent().unwrap());
        let mut b = t.jpeg.clone();
        b.extend_from_slice(&t.w.to_le_bytes());
        b.extend_from_slice(&t.h.to_le_bytes());
        let _ = fs::write(c, b);
    }
    Ok(t)
}

fn make(path: &Path) -> Result<Thumb, String> {
    let ext = ext_of(path);
    #[cfg(windows)]
    {
        if let Ok(img) = crate::wic::shell_thumbnail(path, THUMB_MAX) {
            let (w, h) = dims(path, &ext);
            return Ok(Thumb { jpeg: encode(&flatten(&img))?, w, h });
        }
    }
    if matches!(ext.as_str(), "jpg" | "jpeg" | "jfif") {
        if let Ok(t) = jpeg_fast(path) {
            return Ok(t);
        }
    }
    let img: DynamicImage = if convert::needs_decode(&ext) {
        DynamicImage::ImageRgba8(convert::decode_full(path, &ext)?)
    } else if matches!(ext.as_str(), "svg" | "avif") {
        return Err("화면에서 직접 만듦".into());
    } else {
        crate::tools::load_for_edit(path)?
    };
    let (w, h) = (img.width(), img.height());
    let small = img.thumbnail(THUMB_MAX, THUMB_MAX);
    Ok(Thumb { jpeg: encode(&flatten(&small.to_rgba8()))?, w, h })
}

#[cfg_attr(not(windows), allow(dead_code))]
/// 원본 크기만 빠르게 (헤더만 읽음). EXIF 회전 반영
fn dims(path: &Path, ext: &str) -> (u32, u32) {
    if convert::needs_decode(ext) {
        return (0, 0);
    }
    let (w, h) = image::image_dimensions(path).unwrap_or((0, 0));
    if matches!(ext, "jpg" | "jpeg" | "jfif") && orientation(path) >= 5 { (h, w) } else { (w, h) }
}

fn orientation(path: &Path) -> u32 {
    let Ok(f) = fs::File::open(path) else { return 1 };
    let mut r = std::io::BufReader::new(f);
    exif::Reader::new()
        .read_from_container(&mut r)
        .ok()
        .and_then(|ex| ex.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)))
        .unwrap_or(1)
}

// JPEG는 1/2·1/4·1/8 크기로 바로 풀 수 있어서 매우 빠르다
fn jpeg_fast(path: &Path) -> Result<Thumb, String> {
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut dec = jpeg_decoder::Decoder::new(std::io::BufReader::new(f));
    dec.read_info().map_err(|e| e.to_string())?;
    let info = dec.info().ok_or("정보 없음")?;
    let (fw, fh) = (info.width as u32, info.height as u32);
    let (sw, sh) = dec.scale(THUMB_MAX as u16, THUMB_MAX as u16).map_err(|e| e.to_string())?;
    let pixels = dec.decode().map_err(|e| e.to_string())?;
    let info = dec.info().ok_or("정보 없음")?;
    let (sw, sh) = (sw as u32, sh as u32);
    let img: RgbaImage = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => DynamicImage::ImageRgb8(RgbImage::from_raw(sw, sh, pixels).ok_or("크기 오류")?).to_rgba8(),
        jpeg_decoder::PixelFormat::L8 => DynamicImage::ImageLuma8(image::GrayImage::from_raw(sw, sh, pixels).ok_or("크기 오류")?).to_rgba8(),
        _ => return Err("CMYK 등은 일반 경로 사용".into()),
    };
    let o = orientation(path);
    let img = DynamicImage::ImageRgba8(img);
    let img = match o {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    };
    let (w, h) = if o >= 5 { (fh, fw) } else { (fw, fh) };
    let small = img.thumbnail(THUMB_MAX, THUMB_MAX);
    Ok(Thumb { jpeg: encode(&flatten(&small.to_rgba8()))?, w, h })
}

fn flatten(img: &RgbaImage) -> RgbImage {
    RgbImage::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y).0;
        let a = p[3] as u32;
        let f = |c: u8, b: u8| ((c as u32 * a + b as u32 * (255 - a)) / 255) as u8;
        image::Rgb([f(p[0], BG[0]), f(p[1], BG[1]), f(p[2], BG[2])])
    })
}

fn encode(img: &RgbImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 84);
    img.write_with_encoder(enc).map_err(|e| e.to_string())?;
    let _ = imageops::FilterType::Triangle;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speed() {
        let Ok(dir) = std::env::var("THUMB_DIR") else { return };
        let mut files: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
        files.sort();
        let t0 = std::time::Instant::now();
        for p in &files {
            let t = make(p);
            match t {
                Ok(t) => {
                    let im = image::load_from_memory(&t.jpeg).unwrap().to_rgb8();
                    println!("{:40} {}x{} thumb {}x{} TL={:?}", p.file_name().unwrap().to_string_lossy(), t.w, t.h, im.width(), im.height(), im.get_pixel(5, 5).0)
                }
                Err(e) => println!("{:40} FAIL {e}", p.file_name().unwrap().to_string_lossy()),
            }
        }
        println!("TOTAL {} files {:?} ({:?}/file)", files.len(), t0.elapsed(), t0.elapsed() / files.len().max(1) as u32);
    }
}
