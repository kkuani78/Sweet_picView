//! Windows 파일 끌기 (OLE DoDragDrop + CF_HDROP).
//! 경로를 "진짜 경로"로 바꾸지 않고 받은 그대로 넘긴다 → 네트워크 드라이브(N:\…),
//! 여러 폴더의 파일, 수천 개 파일도 바로 끌 수 있다.
//! 데이터 객체·끌기 소스 부분은 crabnebula `drag` 2.1.1 (MIT/Apache-2.0)을 바탕으로 고쳤다.

use std::path::PathBuf;

/// 끌기 그림: (가로, 세로, 미리 곱한 BGRA 픽셀)
pub type DragImage = (u32, u32, Vec<u8>);

/// 끌기를 시작해서 놓으면 Ok(true), 취소하면 Ok(false). 반드시 창의 메인 스레드에서 부른다.
#[cfg(windows)]
pub fn start(paths: &[PathBuf], image: Option<DragImage>) -> Result<bool, String> {
    imp::start(paths, image)
}

#[cfg(not(windows))]
pub fn start(_paths: &[PathBuf], _image: Option<DragImage>) -> Result<bool, String> {
    Err("끌어서 보내기는 Windows에서만 됩니다".into())
}

#[cfg(windows)]
mod imp {
    use super::DragImage;
    use std::{ffi::c_void, iter::once, os::windows::ffi::OsStrExt, path::PathBuf};
    use windows::{
        core::*,
        Win32::{
            Foundation::*,
            Graphics::Gdi::{CreateBitmap, DeleteObject},
            System::Com::*,
            System::Memory::*,
            System::Ole::{DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY},
            System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
            UI::Shell::{CLSID_DragDropHelper, IDragSourceHelper, SHCreateDataObject, DROPFILES, SHDRAGIMAGE},
        },
    };

    #[implement(IDataObject)]
    struct DataObject {
        files: Vec<PathBuf>,
        inner_shell_obj: IDataObject,
    }

    #[implement(IDropSource)]
    struct DropSource(());

    #[allow(non_snake_case)]
    impl IDropSource_Impl for DropSource {
        fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
            if fescapepressed.as_bool() {
                DRAGDROP_S_CANCEL
            } else if (grfkeystate & MK_LBUTTON) == MODIFIERKEYS_FLAGS(0) {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }

        fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    impl DataObject {
        fn is_supported_format(pformatetc: *const FORMATETC) -> bool {
            if let Some(f) = unsafe { pformatetc.as_ref() } {
                !(f.tymed as i32 != TYMED_HGLOBAL.0 || f.cfFormat != CF_HDROP.0 || f.dwAspect != DVASPECT_CONTENT.0)
            } else {
                false
            }
        }

        // 경로 목록 → DROPFILES (경로는 받은 그대로)
        fn clone_drop_hglobal(&self) -> Result<HGLOBAL> {
            let mut buffer: Vec<u16> = Vec::new();
            for path in &self.files {
                buffer.extend(path.as_os_str().encode_wide().chain(once(0)));
            }
            buffer.push(0);
            let size = std::mem::size_of::<DROPFILES>() + buffer.len() * 2;
            unsafe {
                let handle = GlobalAlloc(GMEM_FIXED, size)?;
                let ptr = GlobalLock(handle);
                if ptr.is_null() {
                    return Err(Error::from(E_OUTOFMEMORY));
                }
                let header = ptr as *mut DROPFILES;
                (*header).pFiles = std::mem::size_of::<DROPFILES>() as u32;
                (*header).fWide = BOOL(1);
                std::ptr::copy(
                    buffer.as_ptr() as *const c_void,
                    ptr.add(std::mem::size_of::<DROPFILES>()),
                    buffer.len() * 2,
                );
                let _ = GlobalUnlock(handle);
                Ok(handle)
            }
        }
    }

    #[allow(non_snake_case)]
    impl IDataObject_Impl for DataObject {
        fn GetData(&self, pformatetc: *const FORMATETC) -> Result<STGMEDIUM> {
            unsafe {
                if Self::is_supported_format(pformatetc) {
                    Ok(STGMEDIUM {
                        tymed: TYMED_HGLOBAL.0 as u32,
                        u: STGMEDIUM_0 { hGlobal: self.clone_drop_hglobal()? },
                        pUnkForRelease: std::mem::ManuallyDrop::new(None),
                    })
                } else {
                    self.inner_shell_obj.GetData(pformatetc)
                }
            }
        }

        fn GetDataHere(&self, _pformatetc: *const FORMATETC, _pmedium: *mut STGMEDIUM) -> Result<()> {
            Err(Error::new(DV_E_FORMATETC, HSTRING::new()))
        }

        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            unsafe {
                if Self::is_supported_format(pformatetc) {
                    S_OK
                } else {
                    self.inner_shell_obj.QueryGetData(pformatetc)
                }
            }
        }

        fn GetCanonicalFormatEtc(&self, _pformatectin: *const FORMATETC, pformatetcout: *mut FORMATETC) -> HRESULT {
            unsafe { (*pformatetcout).ptd = std::ptr::null_mut() };
            E_NOTIMPL
        }

        fn SetData(&self, pformatetc: *const FORMATETC, pmedium: *const STGMEDIUM, frelease: BOOL) -> Result<()> {
            unsafe { self.inner_shell_obj.SetData(pformatetc, pmedium, frelease) }
        }

        fn EnumFormatEtc(&self, _dwdirection: u32) -> Result<IEnumFORMATETC> {
            Err(Error::new(E_NOTIMPL, HSTRING::new()))
        }

        fn DAdvise(&self, _pformatetc: *const FORMATETC, _advf: u32, _padvsink: Option<&IAdviseSink>) -> Result<u32> {
            Err(Error::new(OLE_E_ADVISENOTSUPPORTED, HSTRING::new()))
        }

        fn DUnadvise(&self, _dwconnection: u32) -> Result<()> {
            Err(Error::new(OLE_E_ADVISENOTSUPPORTED, HSTRING::new()))
        }

        fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
            Err(Error::new(OLE_E_ADVISENOTSUPPORTED, HSTRING::new()))
        }
    }

    pub fn start(paths: &[PathBuf], image: Option<DragImage>) -> std::result::Result<bool, String> {
        unsafe {
            let _ = OleInitialize(Some(std::ptr::null_mut()));
            let inner: IDataObject = SHCreateDataObject(None, None, None).map_err(|e| e.to_string())?;
            let data: IDataObject = DataObject { files: paths.to_vec(), inner_shell_obj: inner }.into();

            // 끌 때 마우스를 따라오는 작은 그림
            if let Some((w, h, px)) = image {
                if w > 0 && h > 0 && px.len() == (w * h * 4) as usize {
                    let hbmp = CreateBitmap(w as i32, h as i32, 1, 32, Some(px.as_ptr() as *const c_void));
                    if hbmp.0 != 0 {
                        let helper: Result<IDragSourceHelper> = CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_ALL);
                        let ok = match helper {
                            Ok(helper) => {
                                let img = SHDRAGIMAGE {
                                    sizeDragImage: SIZE { cx: w as i32, cy: h as i32 },
                                    ptOffset: POINT { x: w as i32 / 2, y: h as i32 / 2 },
                                    hbmpDragImage: hbmp,
                                    crColorKey: COLORREF(0xFFFF_FFFF),
                                };
                                helper.InitializeFromBitmap(&img, &data).is_ok()
                            }
                            Err(_) => false,
                        };
                        // 성공하면 그림은 Windows가 가져가서 지운다
                        if !ok {
                            let _ = DeleteObject(hbmp);
                        }
                    }
                }
            }

            let src: IDropSource = DropSource(()).into();
            let mut effect = DROPEFFECT::default();
            let hr = DoDragDrop(&data, &src, DROPEFFECT_COPY, &mut effect);
            Ok(hr == DRAGDROP_S_DROP)
        }
    }
}
