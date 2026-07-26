use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    service: &'static str,
    status: &'static str,
}

#[tauri::command]
fn health() -> HealthResponse {
    HealthResponse {
        service: arc_recall_core::SERVICE_NAME,
        status: arc_recall_core::health_status(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![health])
        .run(tauri::generate_context!())
        .expect("failed to run ArcRecall");
}
