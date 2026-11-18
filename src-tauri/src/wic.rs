// Windows 이미지 코덱(WIC)으로 읽기: HEIC(확장 설치 시), TIFF, 일부 RAW 등
use image::RgbaImage;
use std::path::Path;
use windows::core::HSTRING;
use windows::Win32::Foundation::GENERIC_READ;
use windows::Win32::Graphics::Imaging::*;
use windows::Win32::System::Com::*;

pub fn decode(path: &Path) -> Result<RgbaImage, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let name = HSTRING::from(path.as_os_str());
        let decoder = factory
            .CreateDecoderFromFilename(&name, None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)
            .map_err(|e| e.to_string())?;
        let frame = decoder.GetFrame(0).map_err(|e| e.to_string())?;
        let conv = factory.CreateFormatConverter().map_err(|e| e.to_string())?;
        conv.Initialize(&frame, &GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)
            .map_err(|e| e.to_string())?;
        let (mut w, mut h) = (0u32, 0u32);
        conv.GetSize(&mut w, &mut h).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        conv.CopyPixels(std::ptr::null(), w * 4, &mut buf).map_err(|e| e.to_string())?;
        RgbaImage::from_raw(w, h, buf).ok_or_else(|| "WIC 변환 실패".to_string())
    }
}

/// Windows 탐색기 썸네일 (이미 만들어진 것이 있으면 바로 나옴)
pub fn shell_thumbnail(path: &Path, size: u32) -> Result<RgbaImage, String> {
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS,
    };
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT, SIIGBF_THUMBNAILONLY};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let name = HSTRING::from(path.as_os_str());
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&name, None).map_err(|e| e.to_string())?;
        let hbmp = factory
            .GetImage(SIZE { cx: size as i32, cy: size as i32 }, SIIGBF_THUMBNAILONLY | SIIGBF_RESIZETOFIT)
            .map_err(|e| e.to_string())?;
        let mut bm = BITMAP::default();
        let ok = GetObjectW(hbmp, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
        if ok == 0 || bm.bmWidth <= 0 || bm.bmHeight == 0 {
            let _ = DeleteObject(hbmp);
            return Err("썸네일 없음".into());
        }
        let w = bm.bmWidth;
        let h = bm.bmHeight.abs();
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let hdc = CreateCompatibleDC(None);
        let lines = GetDIBits(hdc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteDC(hdc);
        let _ = DeleteObject(hbmp);
        if lines == 0 {
            return Err("썸네일 읽기 실패".into());
        }
        // BGRA → RGBA. 알파가 전부 0이면 불투명으로 취급
        let all_zero_alpha = buf.chunks_exact(4).all(|p| p[3] == 0);
        for p in buf.chunks_exact_mut(4) {
            p.swap(0, 2);
            if all_zero_alpha {
                p[3] = 255;
            } else if p[3] > 0 && p[3] < 255 {
                // 미리 곱해진 알파 되돌리기
                let a = p[3] as u32;
                for c in 0..3 {
                    p[c] = ((p[c] as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }
        RgbaImage::from_raw(w as u32, h as u32, buf).ok_or_else(|| "썸네일 변환 실패".to_string())
    }
}
