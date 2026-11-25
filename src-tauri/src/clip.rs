// 클립스튜디오(.clip) 파일: 안에 든 미리보기 이미지와 캔버스 크기만 읽는다.
//
// .clip = "CSFCHUNK" 머리 + 여러 덩어리(CHNK). 그중 "SQLi" 덩어리가 SQLite 데이터베이스이고,
// CanvasPreview 표에 클립스튜디오가 저장할 때 만든 합쳐진 그림(PNG)이 들어 있다.
// SQLite 라이브러리 없이, 필요한 표 두 개만 직접 읽는다 (설치파일 크기를 늘리지 않기 위해).
// 파일 전체가 아니라 SQLite 덩어리만 읽으므로 네트워크 드라이브에서도 빠르다.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub struct ClipPreview {
    /// 미리보기 이미지 (보통 PNG)
    pub data: Vec<u8>,
    pub preview_w: u32,
    pub preview_h: u32,
    /// 원본 캔버스 크기 (모르면 0)
    pub canvas_w: u32,
    pub canvas_h: u32,
}

pub fn preview(path: &Path) -> Result<ClipPreview, String> {
    let db = read_sqlite_chunk(path)?;
    let db = Db::new(&db)?;
    let mut best: Option<(u64, Vec<u8>, u32, u32)> = None;
    db.for_each_row("CanvasPreview", &["ImageWidth", "ImageHeight", "ImageData"], |v| {
        let (w, h) = (v[0].as_int() as u32, v[1].as_int() as u32);
        if let Val::Blob(b) = &v[2] {
            let area = w as u64 * h as u64;
            if best.as_ref().map(|x| area > x.0).unwrap_or(true) {
                best = Some((area, b.to_vec(), w, h));
            }
        }
    })?;
    let (_, data, preview_w, preview_h) = best.ok_or("미리보기가 없는 파일입니다")?;
    let (mut canvas_w, mut canvas_h) = (0, 0);
    let _ = db.for_each_row("Canvas", &["CanvasWidth", "CanvasHeight"], |v| {
        canvas_w = v[0].as_f64().round() as u32;
        canvas_h = v[1].as_f64().round() as u32;
    });
    Ok(ClipPreview { data, preview_w, preview_h, canvas_w, canvas_h })
}

/// CHNK 머리(16바이트)만 건너뛰며 SQLi 덩어리를 찾아 그 부분만 읽는다
fn read_sqlite_chunk(path: &Path) -> Result<Vec<u8>, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut head = [0u8; 24];
    f.read_exact(&mut head).map_err(|_| "클립스튜디오 파일이 아닙니다")?;
    if &head[0..8] != b"CSFCHUNK" {
        return Err("클립스튜디오 파일이 아닙니다".into());
    }
    let mut pos = 24u64;
    while pos + 16 <= len {
        let mut h = [0u8; 16];
        f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
        f.read_exact(&mut h).map_err(|e| e.to_string())?;
        if &h[0..4] != b"CHNK" {
            return Err("파일 구조를 읽을 수 없습니다".into());
        }
        let size = u64::from_be_bytes(h[8..16].try_into().unwrap());
        if &h[4..8] == b"SQLi" {
            if size > 512 * 1024 * 1024 || pos + 16 + size > len {
                return Err("파일 구조를 읽을 수 없습니다".into());
            }
            let mut buf = vec![0u8; size as usize];
            f.read_exact(&mut buf).map_err(|e| e.to_string())?;
            return Ok(buf);
        }
        pos += 16 + size;
    }
    Err("미리보기 정보를 찾지 못했습니다".into())
}

// ---------------- 아주 작은 SQLite 읽기 (표 읽기 전용) ----------------

#[derive(Debug)]
pub enum Val<'a> {
    Null,
    Int(i64),
    Float(f64),
    Text(&'a [u8]),
    Blob(&'a [u8]),
}

impl Val<'_> {
    fn as_int(&self) -> i64 {
        match self { Val::Int(i) => *i, Val::Float(f) => *f as i64, _ => 0 }
    }
    fn as_f64(&self) -> f64 {
        match self { Val::Int(i) => *i as f64, Val::Float(f) => *f, _ => 0.0 }
    }
}

struct Db<'a> {
    d: &'a [u8],
    page_size: usize,
    usable: usize,
}

fn varint(b: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let mut v: u64 = 0;
    for n in 0..9 {
        let c = *b.get(i)?;
        i += 1;
        if n == 8 {
            return Some(((v << 8) | c as u64, i));
        }
        v = (v << 7) | (c & 0x7f) as u64;
        if c & 0x80 == 0 {
            return Some((v, i));
        }
    }
    None
}

fn be(b: &[u8], i: usize, n: usize) -> Option<u64> {
    let s = b.get(i..i + n)?;
    Some(s.iter().fold(0u64, |a, &x| (a << 8) | x as u64))
}

impl<'a> Db<'a> {
    fn new(d: &'a [u8]) -> Result<Self, String> {
        if d.len() < 100 || &d[0..16] != b"SQLite format 3\0" {
            return Err("미리보기 정보를 읽을 수 없습니다".into());
        }
        let ps = be(d, 16, 2).unwrap() as usize;
        let page_size = if ps == 1 { 65536 } else { ps };
        if page_size < 512 || !page_size.is_power_of_two() {
            return Err("미리보기 정보를 읽을 수 없습니다".into());
        }
        let usable = page_size - d[20] as usize;
        Ok(Db { d, page_size, usable })
    }

    fn page(&self, n: u64) -> Option<&'a [u8]> {
        if n == 0 {
            return None;
        }
        let s = (n as usize - 1).checked_mul(self.page_size)?;
        self.d.get(s..s + self.page_size)
    }

    /// 표 b-tree의 모든 행 내용(record)을 차례로 넘겨준다
    fn walk(&self, root: u64, f: &mut dyn FnMut(Vec<u8>)) -> Option<()> {
        let mut stack = vec![root];
        let mut visited = 0usize;
        while let Some(pn) = stack.pop() {
            visited += 1;
            if visited > self.d.len() / self.page_size + 1 {
                return None; // 고리 방지
            }
            let p = self.page(pn)?;
            let h = if pn == 1 { 100 } else { 0 };
            let kind = *p.get(h)?;
            let ncell = be(p, h + 3, 2)? as usize;
            let hdr = if kind == 0x05 { 12 } else { 8 };
            match kind {
                0x05 => {
                    // 안쪽 페이지: 순서대로 보려면 오른쪽 끝을 먼저 쌓는다
                    stack.push(be(p, h + 8, 4)?);
                    for c in (0..ncell).rev() {
                        let off = be(p, h + hdr + c * 2, 2)? as usize;
                        stack.push(be(p, off, 4)?);
                    }
                }
                0x0d => {
                    for c in 0..ncell {
                        let off = be(p, h + hdr + c * 2, 2)? as usize;
                        let (plen, i) = varint(p, off)?;
                        let (_rowid, i) = varint(p, i)?;
                        f(self.payload(p, i, plen as usize)?);
                    }
                }
                _ => return None,
            }
        }
        Some(())
    }

    fn payload(&self, p: &[u8], start: usize, len: usize) -> Option<Vec<u8>> {
        let u = self.usable;
        let x = u - 35;
        if len <= x {
            return Some(p.get(start..start + len)?.to_vec());
        }
        let m = ((u - 12) * 32 / 255) - 23;
        let k = m + ((len - m) % (u - 4));
        let local = if k <= x { k } else { m };
        let mut out = Vec::with_capacity(len);
        out.extend_from_slice(p.get(start..start + local)?);
        let mut next = be(p, start + local, 4)?;
        while out.len() < len {
            let op = self.page(next)?;
            let take = (len - out.len()).min(u - 4);
            out.extend_from_slice(op.get(4..4 + take)?);
            next = be(op, 0, 4)?;
        }
        Some(out)
    }

    /// 표 이름으로 첫 페이지 번호와 열 이름 목록 찾기 (sqlite_master)
    fn table(&self, name: &str) -> Option<(u64, Vec<String>)> {
        let mut found = None;
        self.walk(1, &mut |rec| {
            if found.is_some() {
                return;
            }
            if let Some(v) = record(&rec) {
                if v.len() >= 5 && matches!(&v[0], Val::Text(t) if *t == b"table") && matches!(&v[1], Val::Text(t) if *t == name.as_bytes()) {
                    if let Val::Text(sql) = &v[4] {
                        found = Some((v[3].as_int() as u64, columns(&String::from_utf8_lossy(sql))));
                    }
                }
            }
        })?;
        found
    }

    fn for_each_row(&self, table: &str, cols: &[&str], mut f: impl FnMut(&[Val])) -> Result<(), String> {
        let (root, names) = self.table(table).ok_or_else(|| format!("{table} 표가 없습니다"))?;
        let idx: Vec<usize> = cols
            .iter()
            .map(|c| names.iter().position(|n| n.eq_ignore_ascii_case(c)))
            .collect::<Option<_>>()
            .ok_or("열을 찾지 못했습니다")?;
        self.walk(root, &mut |rec| {
            if let Some(mut v) = record(&rec) {
                let picked: Vec<Val> = idx.iter().map(|&i| if i < v.len() { std::mem::replace(&mut v[i], Val::Null) } else { Val::Null }).collect();
                f(&picked);
            }
        })
        .ok_or("미리보기 정보를 읽을 수 없습니다")?;
        Ok(())
    }
}

/// CREATE TABLE 문에서 열 이름만 뽑는다
fn columns(sql: &str) -> Vec<String> {
    let (Some(a), Some(b)) = (sql.find('('), sql.rfind(')')) else { return vec![] };
    let mut out = Vec::new();
    let (mut depth, mut cur) = (0, String::new());
    for ch in sql[a + 1..b].chars() {
        match ch {
            '(' => { depth += 1; cur.push(ch); }
            ')' => { depth -= 1; cur.push(ch); }
            ',' if depth == 0 => { out.push(std::mem::take(&mut cur)); }
            _ => cur.push(ch),
        }
    }
    out.push(cur);
    out.iter()
        .filter_map(|c| c.split_whitespace().next().map(|s| s.trim_matches(|c| c == '"' || c == '`' || c == '[' || c == ']').to_string()))
        .collect()
}

fn record(r: &[u8]) -> Option<Vec<Val<'_>>> {
    let (hlen, mut i) = varint(r, 0)?;
    let hlen = hlen as usize;
    let mut types = Vec::new();
    while i < hlen {
        let (t, ni) = varint(r, i)?;
        types.push(t);
        i = ni;
    }
    let mut pos = hlen;
    let mut out = Vec::with_capacity(types.len());
    for t in types {
        let (v, n) = match t {
            0 => (Val::Null, 0),
            1..=6 => {
                let n = [0, 1, 2, 3, 4, 6, 8][t as usize];
                let raw = be(r, pos, n)?;
                let shift = 64 - n * 8;
                (Val::Int(((raw << shift) as i64) >> shift), n)
            }
            7 => (Val::Float(f64::from_bits(be(r, pos, 8)?)), 8),
            8 => (Val::Int(0), 0),
            9 => (Val::Int(1), 0),
            t if t >= 12 && t % 2 == 0 => {
                let n = ((t - 12) / 2) as usize;
                (Val::Blob(r.get(pos..pos + n)?), n)
            }
            t if t >= 13 => {
                let n = ((t - 13) / 2) as usize;
                (Val::Text(r.get(pos..pos + n)?), n)
            }
            _ => return None,
        };
        out.push(v);
        pos += n;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 실제 .clip 파일로 확인: CLIP_SAMPLES=파일1;파일2 cargo test clip
    #[test]
    fn clip_samples() {
        let Ok(list) = std::env::var("CLIP_SAMPLES") else { return };
        for p in list.split(';') {
            let r = preview(Path::new(p)).unwrap();
            let img = image::load_from_memory(&r.data).unwrap();
            assert_eq!((img.width(), img.height()), (r.preview_w, r.preview_h));
            assert!(r.canvas_w >= r.preview_w && r.canvas_h >= r.preview_h);
            println!("{p}: 미리보기 {}x{}, 캔버스 {}x{}", r.preview_w, r.preview_h, r.canvas_w, r.canvas_h);
        }
    }

    #[test]
    fn not_clip() {
        let p = std::env::temp_dir().join("spv-not.clip");
        std::fs::write(&p, b"hello").unwrap();
        assert!(preview(&p).is_err());
        let _ = std::fs::remove_file(p);
    }
}
