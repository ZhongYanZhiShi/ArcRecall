#[cfg(windows)]
fn clear_clipboard_if_matches_impl(
    expected: &str,
    window: windows_sys::Win32::Foundation::HWND,
) -> Result<bool, String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;

    if window.is_null() {
        return Err("无法获取剪贴板操作所需的窗口句柄。".into());
    }

    let mut opened = false;
    for _ in 0..5 {
        // SAFETY: The synchronous command supplies its live Tauri window. A real
        // window handle prevents unrelated NULL-owner calls from reopening and
        // closing the clipboard during the comparison. The guard closes it.
        if unsafe { OpenClipboard(window) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if !opened {
        return Err(format!(
            "无法打开系统剪贴板：{}",
            std::io::Error::last_os_error()
        ));
    }

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: The current thread opened the clipboard above.
            unsafe {
                CloseClipboard();
            }
        }
    }
    let _guard = ClipboardGuard;

    // SAFETY: The clipboard is open and CF_UNICODETEXT is a standard format.
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
    if handle.is_null() {
        return Ok(false);
    }
    let expected_utf16 = expected.encode_utf16().collect::<Vec<_>>();
    // SAFETY: The clipboard handle refers to a global memory object.
    let available_bytes = unsafe { GlobalSize(handle) };
    if available_bytes < expected_utf16.len().saturating_add(1).saturating_mul(2) {
        return Ok(false);
    }
    // SAFETY: The returned clipboard handle refers to a global memory object
    // for CF_UNICODETEXT. It is unlocked below before any clipboard mutation.
    let pointer = unsafe { GlobalLock(handle) }.cast::<u16>();
    if pointer.is_null() {
        return Ok(false);
    }
    // SAFETY: CF_UNICODETEXT is NUL-terminated. We only read the expected
    // number of units plus the terminator, avoiding an unbounded scan.
    let matches = unsafe {
        expected_utf16
            .iter()
            .enumerate()
            .all(|(index, unit)| pointer.add(index).read() == *unit)
            && pointer.add(expected_utf16.len()).read() == 0
    };
    // SAFETY: `handle` was successfully locked above.
    unsafe {
        GlobalUnlock(handle);
    }
    if !matches {
        return Ok(false);
    }
    // SAFETY: The clipboard remains open on the current thread.
    if unsafe { EmptyClipboard() } == 0 {
        return Err(format!(
            "无法清空系统剪贴板：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(true)
}

#[cfg(not(windows))]
fn clear_clipboard_if_matches_impl(_expected: &str) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub(crate) fn clipboard_clear_if_matches(
    window: tauri::Window,
    expected: String,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let handle = window
            .hwnd()
            .map_err(|error| format!("无法获取剪贴板操作所需的窗口句柄：{error}"))?;
        clear_clipboard_if_matches_impl(&expected, handle.0)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        clear_clipboard_if_matches_impl(&expected)
    }
}
