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
