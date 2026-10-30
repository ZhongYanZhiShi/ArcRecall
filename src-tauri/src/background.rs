use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_notification::NotificationExt;

pub(crate) fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 ArcRecall", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "退出并停止任务", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &exit])?;
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("ArcRecall · 关闭窗口后继续运行")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = background_show(app.clone());
            }
            "exit" => {
                background_exit(app.clone());
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn notify_task_finished(app: tauri::AppHandle, success: bool) -> Result<(), String> {
    app.notification()
        .builder()
        .title("ArcRecall")
        .body(if success {
            "归档任务已完成，请打开应用查看结果。"
        } else {
            "归档任务未全部完成，请打开应用查看详情。"
        })
        .show()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn background_show(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn background_exit(app: tauri::AppHandle) {
    super::request_app_shutdown(&app);
}
