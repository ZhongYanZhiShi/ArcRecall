const HISTORY_PASSWORD_PREFIX: &str = "dpapi:v1:";

pub fn is_protected_history_password(value: &str) -> bool {
    value.starts_with(HISTORY_PASSWORD_PREFIX)
}

#[cfg(windows)]
pub fn protect_history_password(password: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };

    let input_length = u32::try_from(password.len()).map_err(|_| "历史密码过长。")?;
    let entropy = b"ArcRecall history password v1";
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_length,
        pbData: password.as_ptr().cast_mut(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: All input slices remain alive for the call. DPAPI allocates the
    // output with LocalAlloc and documents that callers release it with
    // LocalFree, which is done after copying the bytes below.
    let succeeded = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            &entropy_blob,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 {
        return Err(format!(
            "无法使用 Windows 当前用户凭据保护历史密码：{}",
            std::io::Error::last_os_error()
        ));
    }
    if output.cbData > 0 && output.pbData.is_null() {
        return Err("Windows 返回了无效的历史密码保护数据。".into());
    }

    // SAFETY: CryptProtectData returned a valid `output` buffer of cbData
    // bytes. It remains valid until LocalFree is called below.
    let encrypted = if output.cbData == 0 {
        Vec::new()
    } else {
        // SAFETY: A non-empty DPAPI output was checked to have a non-null
        // pointer above and remains allocated until LocalFree below.
        unsafe {
            std::slice::from_raw_parts(output.pbData.cast_const(), output.cbData as usize).to_vec()
        }
    };
    // SAFETY: output.pbData was allocated by CryptProtectData and has not been
    // freed yet.
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(format!(
        "{HISTORY_PASSWORD_PREFIX}{}",
        hex::encode(encrypted)
    ))
}

#[cfg(windows)]
pub fn unprotect_history_password(value: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let Some(encoded) = value.strip_prefix(HISTORY_PASSWORD_PREFIX) else {
        return Ok(value.to_owned());
    };
    let mut encrypted =
        hex::decode(encoded).map_err(|_| "历史密码的本地保护数据已损坏，无法解密。".to_string())?;
    let encrypted_length = u32::try_from(encrypted.len()).map_err(|_| "历史密码保护数据过长。")?;
    let entropy = b"ArcRecall history password v1";
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted_length,
        pbData: encrypted.as_mut_ptr(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: The encrypted and entropy buffers remain valid for the call.
    // DPAPI allocates output with LocalAlloc and it is released below.
    let succeeded = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &entropy_blob,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 {
        return Err(format!(
            "无法使用 Windows 当前用户凭据读取历史密码：{}",
            std::io::Error::last_os_error()
        ));
    }
    if output.cbData > 0 && output.pbData.is_null() {
        return Err("Windows 返回了无效的历史密码明文数据。".into());
    }

    // SAFETY: CryptUnprotectData returned a valid output buffer of cbData
    // bytes. It remains valid until LocalFree is called below.
    let plaintext = if output.cbData == 0 {
        Vec::new()
    } else {
        // SAFETY: A non-empty DPAPI output was checked to have a non-null
        // pointer above and remains allocated until LocalFree below.
        unsafe {
            std::slice::from_raw_parts(output.pbData.cast_const(), output.cbData as usize).to_vec()
        }
    };
    // Clear the DPAPI-owned plaintext before releasing it.
    // SAFETY: The same valid writable output allocation is still owned here.
    unsafe {
        if output.cbData > 0 {
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        }
        LocalFree(output.pbData.cast());
    }
    String::from_utf8(plaintext).map_err(|_| "历史密码不是有效的 UTF-8 文本。".to_string())
}

#[cfg(not(windows))]
pub fn protect_history_password(_password: &str) -> Result<String, String> {
    Err("当前平台尚未提供历史密码的本地凭据保护实现。".into())
}

#[cfg(not(windows))]
pub fn unprotect_history_password(value: &str) -> Result<String, String> {
    if is_protected_history_password(value) {
        Err("当前平台无法读取 Windows DPAPI 保护的历史密码。".into())
    } else {
        Ok(value.to_owned())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn history_password_round_trips_without_embedding_plaintext() {
        let protected = protect_history_password("本机 secret-123").unwrap();

        assert!(is_protected_history_password(&protected));
        assert!(!protected.contains("secret-123"));
        assert_eq!(
            unprotect_history_password(&protected).unwrap(),
            "本机 secret-123"
        );
    }
}
