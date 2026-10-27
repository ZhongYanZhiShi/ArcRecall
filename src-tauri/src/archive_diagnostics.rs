use crate::AppState;
use serde::Serialize;
use tauri::State;
#[tauri::command]
pub(crate) async fn archive_volume_diagnostics(
    path: String,
) -> Result<arc_recall_core::tools::volume_diagnostics::VolumeDiagnostics, String> {
    tauri::async_runtime::spawn_blocking(move || {
        arc_recall_core::tools::volume_diagnostics::diagnose_volumes(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preflight {
    declared_bytes: u64,
    entries: usize,
    available_bytes: Option<u64>,
    exceeds_limit: bool,
    insufficient_space: bool,
}
#[tauri::command]
pub(crate) async fn archive_space_preflight(
    state: State<'_, AppState>,
    path: String,
    output: String,
    password: Option<String>,
) -> Result<Preflight, String> {
    let lease = state.lifecycle.begin()?;
    let seven_zip = crate::engine_commands::require_seven_zip(&state).await?;
    let limits = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .load()
        .map_err(|e| e.to_string())?
        .recovery
        .extraction_limits;
    tauri::async_runtime::spawn_blocking(move || {
        let listing = arc_recall_core::tools::preview_archive(
            std::path::Path::new(&path),
            password.as_deref(),
            &seven_zip,
            &lease.cancellation,
        )?;
        let available = arc_recall_core::tools::available_space(std::path::Path::new(&output))
            .map_err(|e| e.to_string())?;
        Ok(Preflight {
            declared_bytes: listing.total_bytes,
            entries: listing.total_entries,
            available_bytes: available,
            exceeds_limit: listing.total_bytes > u64::from(limits.max_gib) * 1024 * 1024 * 1024
                || listing.total_entries as u64 > u64::from(limits.max_entries),
            insufficient_space: available
                .is_some_and(|bytes| bytes < listing.total_bytes.saturating_add(256 * 1024 * 1024)),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
