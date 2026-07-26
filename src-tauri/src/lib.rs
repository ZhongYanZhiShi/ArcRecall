use std::path::PathBuf;
use std::sync::Mutex;

use arc_recall_core::{
    DictionaryCandidateAddSummary, DictionaryCandidateQuery, DictionaryCandidateStore,
    DictionaryListResult, SERVICE_NAME, health_status,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

struct DictionaryState {
    store: Mutex<DictionaryCandidateStore>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    service: &'static str,
    status: &'static str,
}

#[tauri::command]
fn health() -> HealthResponse {
    HealthResponse {
        service: SERVICE_NAME,
        status: health_status(),
    }
}

#[tauri::command]
fn dictionary_list(
    state: State<'_, DictionaryState>,
    query: DictionaryCandidateQuery,
) -> Result<DictionaryListResult, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store.list(&query).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_count(state: State<'_, DictionaryState>) -> Result<u64, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store.count().map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_add(
    state: State<'_, DictionaryState>,
    candidates: Vec<String>,
) -> Result<DictionaryCandidateAddSummary, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store.add_candidates(candidates).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_import_file(
    state: State<'_, DictionaryState>,
    path: String,
) -> Result<DictionaryCandidateAddSummary, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store.import_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_delete(state: State<'_, DictionaryState>, ids: Vec<i64>) -> Result<u64, String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store.delete(&ids).map_err(|e| e.to_string())
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    Ok(dir.join("arcrecall.db"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let path = database_path(app.handle())?;
            let store = DictionaryCandidateStore::open(&path)
                .map_err(|e| format!("open dictionary store: {e}"))?;
            app.manage(DictionaryState {
                store: Mutex::new(store),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            dictionary_list,
            dictionary_count,
            dictionary_add,
            dictionary_import_file,
            dictionary_delete,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ArcRecall");
}
