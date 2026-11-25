// 화면(웹뷰)이 직접 못 읽는 형식을 JPEG/PNG로 바꿔서 전달한다.
// TIFF · TGA · EXR · PSD/PSB · IFF(Maya / Amiga) · RAW(내장 미리보기) · HEIC(Windows 기능 사용) · CLIP(내장 미리보기)

use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba, RgbaImage};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const DECODE_EXT: &[&str] = &[
    "tif", "tiff", "tga", "exr", "psd", "psb", "iff", "heic", "heif", "clip",
    "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "pef", "srw",
];
const RAW_EXT: &[&str] = &["cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "pef", "srw"];
const CACHE_VERSION: u32 = 1;

pub fn needs_decode(ext: &str) -> bool {
    DECODE_EXT.contains(&ext)
}

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("sweetpicview-cache")
}

fn cache_key(path: &Path) -> Option<String> {
    let md = fs::metadata(path).ok()?;
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    md.len().hash(&mut h);
    md.modified().ok()?.hash(&mut h);
    CACHE_VERSION.hash(&mut h);
    Some(format!("{:016x}", h.finish()))
}

/// 오래된 캐시 정리 (14일 지난 파일)
pub fn clean_cache() {
    let Ok(rd) = fs::read_dir(cache_dir()) else { return };
    let limit = SystemTime::now() - Duration::from_secs(14 * 24 * 3600);
    for e in rd.flatten() {
        if let Ok(md) = e.metadata() {
            if md.modified().map(|t| t < limit).unwrap_or(false) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

/// 변환된 이미지 바이트와 MIME 형식
pub fn get(path: &Path, ext: &str) -> Result<(Vec<u8>, &'static str), String> {
    let key = cache_key(path);
    if let Some(k) = &key {
        for (e, mime) in [("jpg", "image/jpeg"), ("png", "image/png")] {
            let f = cache_dir().join(format!("{k}.{e}"));
            if let Ok(b) = fs::read(&f) {
                return Ok((b, mime));
            }
        }
    }
    let path_owned = path.to_path_buf();
    let ext_owned = ext.to_string();
    let out = std::panic::catch_unwind(move || produce(&path_owned, &ext_owned))
        .map_err(|_| "변환 중 오류".to_string())??;
    if let Some(k) = key {
        let e = if out.1 == "image/png" { "png" } else { "jpg" };
        let _ = fs::create_dir_all(cache_dir());
        let _ = fs::write(cache_dir().join(format!("{k}.{e}")), &out.0);
    }
    Ok(out)
}

/// 편집(리사이즈)용 전체 디코드
pub fn decode_full(path: &Path, ext: &str) -> Result<RgbaImage, String> {
    let path_owned = path.to_path_buf();
    let ext_owned = ext.to_string();
    std::panic::catch_unwind(move || {
        if RAW_EXT.contains(&ext_owned.as_str()) {
            let (bytes, _) = raw_preview(&path_owned)?;
            return image::load_from_memory(&bytes).map(|i| i.to_rgba8()).map_err(|e| e.to_string());
        }
        decode_any(&path_owned, &ext_owned)
    })
    .map_err(|_| "변환 중 오류".to_string())?
}

fn produce(path: &Path, ext: &str) -> Result<(Vec<u8>, &'static str), String> {
    // 클립스튜디오: 안에 든 미리보기(PNG)를 그대로 전달
    if ext == "clip" {
        let p = crate::clip::preview(path)?;
        let mime = if p.data.starts_with(b"\x89PNG") { "image/png" } else if p.data.starts_with(b"RIFF") { return encode(image::load_from_memory(&p.data).map_err(|e| e.to_string())?.to_rgba8()) } else { "image/jpeg" };
        return Ok((p.data, mime));
    }
    // RAW: 카메라가 넣어 둔 큰 미리보기 JPEG 사용
    if RAW_EXT.contains(&ext) {
        match raw_preview(path) {
            Ok(r) => return Ok(r),
            Err(e) => {
                #[cfg(windows)]
                if let Ok(img) = crate::wic::decode(path) {
                    return encode(img);
                }
                return Err(e);
            }
        }
    }
    let img = decode_any(path, ext)?;
    encode(img)
}

fn decode_any(path: &Path, ext: &str) -> Result<RgbaImage, String> {
    #[cfg(windows)]
    {
        // Windows 기본 코덱이 잘 읽는 형식은 먼저 시도 (HEIC는 확장 설치 필요)
        if matches!(ext, "heic" | "heif" | "tif" | "tiff") {
            if let Ok(img) = crate::wic::decode(path) {
                return Ok(img);
            }
        }
    }
    let r = match ext {
        "psd" | "psb" => decode_psd(&read(path)?),
        "clip" => image::load_from_memory(&crate::clip::preview(path)?.data).map(|i| i.to_rgba8()).map_err(|e| e.to_string()),
        "iff" => decode_iff(&read(path)?),
        "exr" => decode_float_image(path, ImageFormat::OpenExr),
        "tga" => decode_with(path, ImageFormat::Tga),
        "tif" | "tiff" => decode_float_aware(path, ImageFormat::Tiff),
        "heic" | "heif" => Err("HEIC를 보려면 Microsoft Store에서 'HEIF 이미지 확장'과 'HEVC 비디오 확장'을 설치하세요.".into()),
        _ => Err("지원하지 않는 형식".into()),
    };
    #[cfg(windows)]
    if r.is_err() {
        if let Ok(img) = crate::wic::decode(path) {
            return Ok(img);
        }
    }
    r
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| e.to_string())
}

fn encode(img: RgbaImage) -> Result<(Vec<u8>, &'static str), String> {
    let has_alpha = img.pixels().any(|p| p.0[3] < 255);
    let mut buf = Vec::new();
    if has_alpha {
        let enc = image::codecs::png::PngEncoder::new_with_quality(
            &mut buf,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Sub,
        );
        DynamicImage::ImageRgba8(img).write_with_encoder(enc).map_err(|e| e.to_string())?;
        Ok((buf, "image/png"))
    } else {
        let rgb = DynamicImage::ImageRgba8(img).to_rgb8();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92);
        rgb.write_with_encoder(enc).map_err(|e| e.to_string())?;
        Ok((buf, "image/jpeg"))
    }
}

fn decode_with(path: &Path, fmt: ImageFormat) -> Result<RgbaImage, String> {
    let bytes = read(path)?;
    image::load_from_memory_with_format(&bytes, fmt).map(|i| i.to_rgba8()).map_err(|e| e.to_string())
}

// 선형(linear) 값을 화면용 sRGB로
fn lin_to_srgb(v: f32) -> u8 {
    let v = if v.is_finite() { v.max(0.0) } else { 0.0 };
    let s = if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (s.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

fn float_to_rgba8(img: &image::Rgba32FImage) -> RgbaImage {
    ImageBuffer::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y).0;
        Rgba([lin_to_srgb(p[0]), lin_to_srgb(p[1]), lin_to_srgb(p[2]), (p[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8])
    })
}

// EXR: 항상 선형 → sRGB 변환
fn decode_float_image(path: &Path, fmt: ImageFormat) -> Result<RgbaImage, String> {
    let bytes = read(path)?;
    let img = image::load_from_memory_with_format(&bytes, fmt).map_err(|e| e.to_string())?;
    Ok(float_to_rgba8(&img.to_rgba32f()))
}

// TIFF: 실수형(32bit float)일 때만 선형 → sRGB
fn decode_float_aware(path: &Path, fmt: ImageFormat) -> Result<RgbaImage, String> {
    let bytes = read(path)?;
    let img = image::load_from_memory_with_format(&bytes, fmt).map_err(|e| e.to_string())?;
    Ok(match img {
        DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_) => float_to_rgba8(&img.to_rgba32f()),
        other => other.to_rgba8(),
    })
}

// ---------------- RAW: 내장 JPEG 미리보기 ----------------
fn raw_preview(path: &Path) -> Result<(Vec<u8>, &'static str), String> {
    let data = read(path)?;
    let mut best: Option<(usize, u32, u32)> = None; // (시작 위치, 가로, 세로)
    let mut i = 0usize;
    let mut tried = 0;
    while i + 3 < data.len() && tried < 400 {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            tried += 1;
            let r = image::ImageReader::with_format(Cursor::new(&data[i..]), ImageFormat::Jpeg).into_dimensions();
            if let Ok((w, h)) = r {
                if w >= 64 && h >= 64 && best.map(|b| (w as u64) * (h as u64) > (b.1 as u64) * (b.2 as u64)).unwrap_or(true) {
                    best = Some((i, w, h));
                }
            }
        }
        i += 1;
    }
    let (start, _, _) = best.ok_or("RAW 파일에서 미리보기를 찾지 못했습니다")?;
    let jpeg = &data[start..];
    let orient = raw_orientation(path);
    // 디코드해서 끝(EOI)까지만 잘라 쓰거나, 회전이 필요하면 다시 인코딩
    let img = image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg).map_err(|e| e.to_string())?;
    let img = apply_orientation(img, orient);
    encode(img.to_rgba8())
}

fn raw_orientation(path: &Path) -> u32 {
    let Ok(f) = fs::File::open(path) else { return 1 };
    let mut r = std::io::BufReader::new(f);
    match exif::Reader::new().read_from_container(&mut r) {
        Ok(ex) => ex
            .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
            .unwrap_or(1),
        Err(_) => 1,
    }
}

fn apply_orientation(img: DynamicImage, o: u32) -> DynamicImage {
    match o {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

// ---------------- PSD / PSB (합쳐진 최종 이미지) ----------------
struct Rd<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Rd<'a> {
    fn need(&self, n: usize) -> Result<(), String> {
        if self.p + n > self.b.len() { Err("파일이 잘렸습니다".into()) } else { Ok(()) }
    }
    fn u16(&mut self) -> Result<u16, String> { self.need(2)?; let v = u16::from_be_bytes([self.b[self.p], self.b[self.p + 1]]); self.p += 2; Ok(v) }
    fn u32(&mut self) -> Result<u32, String> { self.need(4)?; let v = u32::from_be_bytes(self.b[self.p..self.p + 4].try_into().unwrap()); self.p += 4; Ok(v) }
    fn u64(&mut self) -> Result<u64, String> { self.need(8)?; let v = u64::from_be_bytes(self.b[self.p..self.p + 8].try_into().unwrap()); self.p += 8; Ok(v) }
    fn skip(&mut self, n: usize) -> Result<(), String> { self.need(n)?; self.p += n; Ok(()) }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], String> { self.need(n)?; let s = &self.b[self.p..self.p + n]; self.p += n; Ok(s) }
}

// PackBits 풀기
fn packbits(src: &[u8], out: &mut Vec<u8>, want: usize) {
    let mut i = 0;
    while i < src.len() && out.len() < want {
        let n = src[i] as i8;
        i += 1;
        if n >= 0 {
            let c = n as usize + 1;
            let end = (i + c).min(src.len());
            out.extend_from_slice(&src[i..end]);
            i = end;
        } else if n != -128 {
            let c = (1 - n as i32) as usize;
            if i < src.len() {
                let v = src[i];
                out.extend(std::iter::repeat(v).take(c));
                i += 1;
            }
        }
    }
    out.resize(want, 0);
}

fn decode_psd(b: &[u8]) -> Result<RgbaImage, String> {
    let mut r = Rd { b, p: 0 };
    if r.bytes(4)? != b"8BPS" { return Err("PSD 파일이 아닙니다".into()); }
    let version = r.u16()?;
    let psb = version == 2;
    r.skip(6)?;
    let channels = r.u16()? as usize;
    let h = r.u32()? as usize;
    let w = r.u32()? as usize;
    let depth = r.u16()?;
    let mode = r.u16()?;
    let cm_len = r.u32()? as usize;
    let palette = r.bytes(cm_len)?.to_vec();
    let res_len = r.u32()? as usize;
    r.skip(res_len)?;
    // 레이어 정보: 레이어 수가 음수면 첫 알파 채널이 투명도
    let lm_len = if psb { r.u64()? as usize } else { r.u32()? as usize };
    let lm_start = r.p;
    let mut alpha_is_transparency = false;
    if lm_len >= 8 {
        let li_len = if psb { r.u64()? } else { r.u32()? as u64 };
        if li_len >= 2 {
            let count = r.u16()? as i16;
            alpha_is_transparency = count < 0;
        }
    }
    r.p = lm_start;
    r.skip(lm_len)?;
    let comp = r.u16()?;
    let bpc = match depth { 1 => 1, 8 => 1, 16 => 2, 32 => 4, _ => return Err(format!("{depth}비트 PSD는 지원하지 않습니다")) };
    let row_bytes = if depth == 1 { (w + 7) / 8 } else { w * bpc };
    let plane_len = row_bytes * h;
    let mut planes: Vec<Vec<u8>> = Vec::with_capacity(channels);
    match comp {
        0 => {
            for _ in 0..channels {
                let avail = (b.len() - r.p).min(plane_len);
                let mut v = r.bytes(avail)?.to_vec();
                v.resize(plane_len, 0);
                planes.push(v);
            }
        }
        1 => {
            let mut counts = Vec::with_capacity(channels * h);
            for _ in 0..channels * h {
                counts.push(if psb { r.u32()? as usize } else { r.u16()? as usize });
            }
            for c in 0..channels {
                let mut plane = Vec::with_capacity(plane_len);
                for y in 0..h {
                    let n = counts[c * h + y];
                    let src = r.bytes(n.min(b.len() - r.p))?;
                    let mut row = Vec::with_capacity(row_bytes);
                    packbits(src, &mut row, row_bytes);
                    plane.extend_from_slice(&row);
                }
                planes.push(plane);
            }
        }
        _ => return Err("압축 방식(ZIP) PSD는 아직 지원하지 않습니다".into()),
    }
    // 채널 값 → 0~255
    let val = |plane: &Vec<u8>, i: usize| -> u8 {
        match bpc {
            1 => plane[i],
            2 => plane[i * 2],
            _ => {
                let f = f32::from_be_bytes(plane[i * 4..i * 4 + 4].try_into().unwrap());
                lin_to_srgb(f)
            }
        }
    };
    let mut img = RgbaImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let px = match mode {
                3 if channels >= 3 => {
                    let a = if alpha_is_transparency && channels >= 4 { val(&planes[3], i) } else { 255 };
                    [val(&planes[0], i), val(&planes[1], i), val(&planes[2], i), a]
                }
                1 | 8 => {
                    let g = val(&planes[0], i);
                    let a = if alpha_is_transparency && channels >= 2 { val(&planes[1], i) } else { 255 };
                    [g, g, g, a]
                }
                4 if channels >= 4 => {
                    // PSD의 CMYK는 반전 저장 (255 = 잉크 없음)
                    let c = 255 - val(&planes[0], i) as u32;
                    let m = 255 - val(&planes[1], i) as u32;
                    let ye = 255 - val(&planes[2], i) as u32;
                    let k = 255 - val(&planes[3], i) as u32;
                    let f = |v: u32| (((255 - v) * (255 - k)) / 255) as u8;
                    [f(c), f(m), f(ye), 255]
                }
                2 => {
                    let idx = planes[0][i] as usize;
                    if palette.len() >= 768 { [palette[idx], palette[256 + idx], palette[512 + idx], 255] } else { [idx as u8; 4] }
                }
                0 => {
                    let byte = planes[0][y * row_bytes + x / 8];
                    let v = if byte & (0x80 >> (x % 8)) != 0 { 0 } else { 255 };
                    [v, v, v, 255]
                }
                _ => return Err("지원하지 않는 PSD 색상 모드".into()),
            };
            img.put_pixel(x as u32, y as u32, Rgba(px));
        }
    }
    Ok(img)
}

// ---------------- IFF (Maya / Amiga ILBM·PBM) ----------------
fn be32(b: &[u8], p: usize) -> usize {
    u32::from_be_bytes(b[p..p + 4].try_into().unwrap()) as usize
}
fn be16(b: &[u8], p: usize) -> usize {
    u16::from_be_bytes([b[p], b[p + 1]]) as usize
}

fn decode_iff(b: &[u8]) -> Result<RgbaImage, String> {
    if b.len() < 12 { return Err("IFF 파일이 너무 작습니다".into()); }
    match &b[0..4] {
        b"FOR4" => decode_maya_iff(b),
        b"FORM" => decode_amiga_iff(b),
        _ => Err("알 수 없는 IFF 형식".into()),
    }
}

// Maya 렌더 IFF: 64×64 타일, 채널은 A·B·G·R 순, 아래쪽부터 저장
fn maya_rle(src: &[u8], pos: &mut usize, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n);
    while out.len() < n && *pos < src.len() {
        let c = src[*pos];
        *pos += 1;
        let cnt = (c & 0x7f) as usize + 1;
        if c & 0x80 != 0 {
            if *pos < src.len() {
                let v = src[*pos];
                *pos += 1;
                out.extend(std::iter::repeat(v).take(cnt));
            }
        } else {
            let end = (*pos + cnt).min(src.len());
            out.extend_from_slice(&src[*pos..end]);
            *pos = end;
        }
    }
    out.resize(n, 0);
    out
}

fn decode_maya_iff(b: &[u8]) -> Result<RgbaImage, String> {
    let mut w = 0usize;
    let mut h = 0usize;
    let mut ch = 4usize;
    let mut bpc = 1usize;
    let mut img: Option<RgbaImage> = None;
    let mut p = 12usize;
    let mut stack_end = vec![b.len()];
    while p + 8 <= *stack_end.last().unwrap() {
        let tag = &b[p..p + 4];
        let size = be32(b, p + 4);
        let body = p + 8;
        let end = (body + size).min(b.len());
        match tag {
            b"FOR4" => {
                // TBMP 묶음 안으로 들어간다
                stack_end.push(end);
                p = body + 4;
                continue;
            }
            b"TBHD" => {
                w = be32(b, body);
                h = be32(b, body + 4);
                let flags = be32(b, body + 12);
                bpc = if be16(b, body + 16) == 0 { 1 } else { 2 };
                ch = if flags & 2 != 0 { 4 } else { 3 };
                if w == 0 || h == 0 || w > 30000 || h > 30000 { return Err("잘못된 IFF 크기".into()); }
                let mut im = RgbaImage::new(w as u32, h as u32);
                for px in im.pixels_mut() { px.0 = [0, 0, 0, 255]; }
                img = Some(im);
            }
            b"RGBA" => {
                let im = img.as_mut().ok_or("IFF 헤더(TBHD)가 없습니다")?;
                let x1 = be16(b, body);
                let y1 = be16(b, body + 2);
                let x2 = be16(b, body + 4);
                let y2 = be16(b, body + 6);
                if x2 < x1 || y2 < y1 || x2 >= w || y2 >= h { p = (end + 3) & !3; continue; }
                let tw = x2 - x1 + 1;
                let th = y2 - y1 + 1;
                let n = tw * th;
                let data = &b[body + 8..end];
                let np = ch * bpc;
                let planes: Vec<Vec<u8>> = if data.len() >= n * np {
                    (0..np).map(|k| (0..n).map(|i| data[i * np + k]).collect()).collect()
                } else {
                    let mut pos = 0;
                    (0..np).map(|_| maya_rle(data, &mut pos, n)).collect()
                };
                // 앞쪽 ch개 평면이 상위 바이트 (A,B,G,R 또는 B,G,R)
                for ty in 0..th {
                    for tx in 0..tw {
                        let i = ty * tw + tx;
                        let get = |c: usize| planes[ch - 1 - c][i]; // c: 0=R 1=G 2=B 3=A
                        let a = if ch == 4 { get(3) } else { 255 };
                        let x = x1 + tx;
                        let y = h - 1 - (y1 + ty);
                        im.put_pixel(x as u32, y as u32, Rgba([get(0), get(1), get(2), a]));
                    }
                }
            }
            _ => {}
        }
        p = (end + 3) & !3;
        while stack_end.len() > 1 && p >= *stack_end.last().unwrap() {
            stack_end.pop();
        }
    }
    img.ok_or_else(|| "IFF 이미지 데이터가 없습니다".into())
}

// Amiga ILBM(비트평면) / PBM(바이트)
fn decode_amiga_iff(b: &[u8]) -> Result<RgbaImage, String> {
    let kind = &b[8..12];
    let pbm = kind == b"PBM ";
    if kind != b"ILBM" && !pbm { return Err("지원하지 않는 IFF 종류".into()); }
    let (mut w, mut h, mut planes, mut masking, mut comp) = (0usize, 0usize, 0usize, 0u8, 0u8);
    let mut cmap: Vec<[u8; 3]> = Vec::new();
    let mut camg = 0u32;
    let mut body: Option<&[u8]> = None;
    let mut p = 12usize;
    while p + 8 <= b.len() {
        let tag = &b[p..p + 4];
        let size = be32(b, p + 4);
        let d = p + 8;
        let end = (d + size).min(b.len());
        match tag {
            b"BMHD" => {
                w = be16(b, d);
                h = be16(b, d + 2);
                planes = b[d + 8] as usize;
                masking = b[d + 9];
                comp = b[d + 10];
            }
            b"CMAP" => cmap = b[d..end].chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect(),
            b"CAMG" if end - d >= 4 => camg = be32(b, d) as u32,
            b"BODY" => body = Some(&b[d..end]),
            _ => {}
        }
        p = end + (size & 1);
    }
    let body = body.ok_or("IFF 이미지 데이터가 없습니다")?;
    if w == 0 || h == 0 { return Err("잘못된 IFF 크기".into()); }
    let ham = camg & 0x800 != 0;
    let ehb = camg & 0x80 != 0;
    if ehb && cmap.len() >= 32 {
        let half: Vec<[u8; 3]> = cmap[..32].iter().map(|c| [c[0] / 2, c[1] / 2, c[2] / 2]).collect();
        cmap.truncate(32);
        cmap.extend(half);
    }
    let row_bytes = if pbm { (w + 1) & !1 } else { ((w + 15) / 16) * 2 };
    let rows_per_line = if pbm { 1 } else { planes + if masking == 1 { 1 } else { 0 } };
    let mut pos = 0usize;
    let mut img = RgbaImage::new(w as u32, h as u32);
    for y in 0..h {
        let mut lines: Vec<Vec<u8>> = Vec::with_capacity(rows_per_line);
        for _ in 0..rows_per_line {
            let mut row = Vec::with_capacity(row_bytes);
            if comp == 1 {
                // ByteRun1
                while row.len() < row_bytes && pos < body.len() {
                    let n = body[pos] as i8;
                    pos += 1;
                    if n >= 0 {
                        let c = n as usize + 1;
                        let end = (pos + c).min(body.len());
                        row.extend_from_slice(&body[pos..end]);
                        pos = end;
                    } else if n != -128 && pos < body.len() {
                        let c = (1 - n as i32) as usize;
                        row.extend(std::iter::repeat(body[pos]).take(c));
                        pos += 1;
                    }
                }
                row.resize(row_bytes, 0);
            } else {
                let end = (pos + row_bytes).min(body.len());
                row.extend_from_slice(&body[pos..end]);
                row.resize(row_bytes, 0);
                pos = end;
            }
            lines.push(row);
        }
        let mut prev = [0u8; 3];
        for x in 0..w {
            let px: [u8; 4] = if pbm {
                let idx = lines[0][x] as usize;
                let c = cmap.get(idx).copied().unwrap_or([idx as u8; 3]);
                [c[0], c[1], c[2], 255]
            } else {
                let mut v: u32 = 0;
                for pl in 0..planes.min(32) {
                    if lines[pl][x / 8] & (0x80 >> (x % 8)) != 0 { v |= 1 << pl; }
                }
                if planes == 24 || planes == 32 {
                    let a = if planes == 32 { (v >> 24) as u8 } else { 255 };
                    [(v & 0xff) as u8, ((v >> 8) & 0xff) as u8, ((v >> 16) & 0xff) as u8, a]
                } else if ham && (planes == 6 || planes == 8) {
                    let cb = planes - 2;
                    let ctl = v >> cb;
                    let val = v & ((1 << cb) - 1);
                    let scale = |x: u32| -> u8 { ((x * 255) / ((1 << cb) - 1)) as u8 };
                    match ctl {
                        0 => { let c = cmap.get(val as usize).copied().unwrap_or([0; 3]); prev = c; }
                        1 => prev[2] = scale(val),
                        2 => prev[0] = scale(val),
                        _ => prev[1] = scale(val),
                    }
                    [prev[0], prev[1], prev[2], 255]
                } else {
                    let c = cmap.get(v as usize).copied().unwrap_or([v as u8; 3]);
                    [c[0], c[1], c[2], 255]
                }
            };
            img.put_pixel(x as u32, y as u32, Rgba(px));
        }
    }
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;
    // 샘플 파일 검증: cargo test -- --nocapture  (SAMPLES 환경변수에 폴더 지정)
    #[test]
    fn samples() {
        let Ok(dir) = std::env::var("SAMPLES") else { return };
        let out = Path::new(&dir).join("out");
        let _ = fs::create_dir_all(&out);
        for e in fs::read_dir(&dir).unwrap().flatten() {
            let p = e.path();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
            if !needs_decode(&ext) { continue; }
            let r = produce(&p, &ext);
            match r {
                Ok((bytes, mime)) => {
                    let name = p.file_name().unwrap().to_string_lossy().to_string();
                    let e2 = if mime == "image/png" { "png" } else { "jpg" };
                    fs::write(out.join(format!("{name}.{e2}")), &bytes).unwrap();
                    println!("OK   {name} -> {mime} {} bytes", bytes.len());
                }
                Err(err) => println!("FAIL {} : {err}", p.display()),
            }
        }
    }
}
