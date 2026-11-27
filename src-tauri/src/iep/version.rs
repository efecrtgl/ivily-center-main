//! Read the version resource of a Windows executable (product name and version).

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionInfo {
    pub product_name: String,
    pub version: (u32, u32, u32),
}

impl VersionInfo {
    pub fn version_string(&self) -> String {
        format!("{}.{}.{}", self.version.0, self.version.1, self.version.2)
    }
}

#[cfg(windows)]
pub fn read(path: &Path) -> Option<VersionInfo> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };

    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let file = wide(path.as_os_str());
    // SAFETY: `file` is a NUL-terminated UTF-16 string; the buffer is sized by the API.
    let size = unsafe { GetFileVersionInfoSizeW(file.as_ptr(), std::ptr::null_mut()) };
    if size == 0 || size > 4 * 1024 * 1024 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    // SAFETY: `data` has `size` bytes as requested by GetFileVersionInfoSizeW.
    if unsafe { GetFileVersionInfoW(file.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let query = |sub: &str| -> Option<(*const u8, u32)> {
        let q = wide(std::ffi::OsStr::new(sub));
        let mut ptr: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        // SAFETY: `data` holds a version resource; VerQueryValueW returns a pointer into it.
        let ok = unsafe { VerQueryValueW(data.as_ptr().cast(), q.as_ptr(), &mut ptr, &mut len) };
        (ok != 0 && !ptr.is_null()).then_some((ptr as *const u8, len))
    };
    let (fixed, len) = query("\\")?;
    if (len as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>() {
        return None;
    }
    // SAFETY: the pointer refers to a VS_FIXEDFILEINFO of at least the checked size inside `data`.
    let f = unsafe { std::ptr::read_unaligned(fixed as *const VS_FIXEDFILEINFO) };
    let version = (f.dwProductVersionMS >> 16, f.dwProductVersionMS & 0xffff, f.dwProductVersionLS >> 16);
    let (trans, tlen) = query("\\VarFileInfo\\Translation")?;
    if tlen < 4 {
        return None;
    }
    // SAFETY: at least one (language, code page) pair of two u16 values is present.
    let (lang, cp) = unsafe {
        (std::ptr::read_unaligned(trans as *const u16), std::ptr::read_unaligned((trans as *const u16).add(1)))
    };
    let (name_ptr, name_len) = query(&format!("\\StringFileInfo\\{lang:04x}{cp:04x}\\ProductName"))?;
    // SAFETY: VerQueryValueW returns `name_len` UTF-16 units (including the terminator) inside `data`.
    let units = unsafe { std::slice::from_raw_parts(name_ptr as *const u16, name_len as usize) };
    let product_name = String::from_utf16_lossy(units).trim_end_matches('\0').to_string();
    Some(VersionInfo { product_name, version })
}

#[cfg(not(windows))]
pub fn read(_path: &Path) -> Option<VersionInfo> {
    None
}
