use std::sync::Mutex;

use arc_recall_core::{
    APP_DATA_FOLDER_NAME, AppPaths, AppSettings, DatabaseInfo, DictionaryCandidateAddSummary,
    DictionaryCandidateQuery, DictionaryCandidateStore, DictionaryListResult, SERVICE_NAME,
    SettingsStore, health_status,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

struct AppState {
    paths: AppPaths,
    dictionary: Mutex<DictionaryCandidateStore>,
    settings: Mutex<SettingsStore>,
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
    state: State<'_, AppState>,
    query: DictionaryCandidateQuery,
) -> Result<DictionaryListResult, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.list(&query).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_count(state: State<'_, AppState>) -> Result<u64, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.count().map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_add(
    state: State<'_, AppState>,
    candidates: Vec<String>,
) -> Result<DictionaryCandidateAddSummary, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.add_candidates(candidates).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_import_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<DictionaryCandidateAddSummary, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.import_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_delete(state: State<'_, AppState>, ids: Vec<i64>) -> Result<u64, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.delete(&ids).map_err(|e| e.to_string())
}

#[tauri::command]
fn database_info(state: State<'_, AppState>) -> Result<DatabaseInfo, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    let count = store.count().map_err(|e| e.to_string())?;
    Ok(DatabaseInfo {
        path: state.paths.database.display().to_string(),
        exists: state.paths.database_exists(),
        candidate_count: count,
        settings_path: state.paths.settings.display().to_string(),
        root_path: state.paths.root.display().to_string(),
    })
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.load().map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(state: State<'_, AppState>, settings: AppSettings) -> Result<AppSettings, String> {
    let store = state.settings.lock().map_err(|e| e.to_string())?;
    store.save(&settings).map_err(|e| e.to_string())?;
    store.load().map_err(|e| e.to_string())
}

/// Data root: `{LocalAppData}/ArcRecall` (not the reverse-domain identifier).
fn resolve_app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("resolve local data dir: {e}"))?;
    let paths = AppPaths::from_root(local.join(APP_DATA_FOLDER_NAME));
    paths
        .ensure_dirs()
        .map_err(|e| format!("create app data dirs: {e}"))?;
    Ok(paths)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let paths = resolve_app_paths(app.handle())?;
            let dictionary = DictionaryCandidateStore::open(&paths.database)
                .map_err(|e| format!("open dictionary store: {e}"))?;
            let settings = SettingsStore::open(&paths.settings)
                .map_err(|e| format!("open settings store: {e}"))?;
            app.manage(AppState {
                paths,
                dictionary: Mutex::new(dictionary),
                settings: Mutex::new(settings),
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
            database_info,
            settings_get,
            settings_set,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ArcRecall");
}
