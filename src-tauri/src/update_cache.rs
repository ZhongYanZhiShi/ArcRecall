use std::{fs, io::Write, path::Path};
use tauri_plugin_updater::{Update, Updater};

pub(crate) fn save_cached(
    directory: &Path,
    manifest: &serde_json::Value,
    bytes: &[u8],
) -> std::io::Result<()> {
    fs::create_dir_all(directory)?;
    // Publish metadata last. Any interrupted/mismatched pair fails verification.
    let mut payload = tempfile::NamedTempFile::new_in(directory)?;
    payload.write_all(bytes)?;
    payload.as_file().sync_all()?;
    payload.persist(directory.join("package.bin"))?;
    let mut metadata = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(&mut metadata, manifest)?;
    metadata.as_file().sync_all()?;
    metadata.persist(directory.join("release.json"))?;
    Ok(())
}

pub(crate) fn restore_cached(
    updater: &Updater,
    directory: &Path,
) -> Result<Option<(Update, Vec<u8>)>, String> {
    let manifest_path = directory.join("release.json");
    if !manifest_path.exists() {
        return Ok(None);
    }
    let result = (|| {
        let manifest = fs::read(&manifest_path).map_err(|e| e.to_string())?;
        let update = updater
            .restore_update(serde_json::from_slice(&manifest).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let Some(update) = update else {
            return Ok(None);
        };
        let bytes = fs::read(directory.join("package.bin")).map_err(|e| e.to_string())?;
        update.verify(&bytes).map_err(|e| e.to_string())?;
        Ok(Some((update, bytes)))
    })();
    if !matches!(result, Ok(Some(_))) {
        // Only remove our two known cache files, never a directory tree.
        let _ = fs::remove_file(manifest_path);
        let _ = fs::remove_file(directory.join("package.bin"));
    }
    result
}
