use crate::AppState;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
static LAST_LAUNCHES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPreferences {
    pub setup_completed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopStatus {
    pub supported: bool,
    pub context_menu: bool,
    pub setup_completed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LaunchRequest {
    pub id: String,
    pub action: String,
    pub path: String,
}

pub(crate) fn initialize(root: &Path, args: Vec<String>) -> Result<Option<File>, String> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("desktop-instance.lock"))
        .map_err(|e| e.to_string())?;
    let primary = match file.try_lock() {
        Ok(()) => true,
        Err(std::fs::TryLockError::WouldBlock) => false,
        Err(error) => return Err(error.to_string()),
    };
    // Upgrades keep existing users out of the first-install walkthrough.
    let preferences_path = root.join("desktop-integration.json");
    if primary && !preferences_path.exists() {
        let mut pending = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
        let preferences = DesktopPreferences {
            setup_completed: root.join("settings.json").exists(),
        };
        pending
            .write_all(&serde_json::to_vec(&preferences).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        pending
            .persist(preferences_path)
            .map_err(|e| e.to_string())?;
    }
    let request = match parse_launch(&args)? {
        Some(request) => Some(request),
        None if !primary => Some(LaunchRequest {
            id: launch_id()?,
            action: "focus".into(),
            path: String::new(),
        }),
        None => None,
    };
    if let Some(request) = request {
        let inbox = root.join("shell-inbox");
        fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
        let mut pending = tempfile::NamedTempFile::new_in(&inbox).map_err(|e| e.to_string())?;
        pending
            .write_all(&serde_json::to_vec(&request).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        pending
            .persist_noclobber(inbox.join(format!("{}.json", request.id)))
            .map_err(|e| e.to_string())?;
    }
    Ok(primary.then_some(file))
}
fn launch_id() -> Result<String, String> {
    Ok(format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ))
}
fn parse_launch(args: &[String]) -> Result<Option<LaunchRequest>, String> {
    if args.get(1).map(String::as_str) != Some("--shell-action") {
        return Ok(None);
    }
    if args.len() != 5
        || args[3] != "--"
        || !["open", "queue", "check"].contains(&args[2].as_str())
        || !Path::new(&args[4]).is_absolute()
    {
        return Err("资源管理器启动参数无效。".into());
    }
    Ok(Some(LaunchRequest {
        id: launch_id()?,
        action: args[2].clone(),
        path: args[4].clone(),
    }))
}
fn preferences(root: &Path) -> Result<DesktopPreferences, String> {
    let path = root.join("desktop-integration.json");
    if !path.exists() {
        return Ok(DesktopPreferences::default());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn desktop_integration_status(
    state: State<'_, AppState>,
) -> Result<DesktopStatus, String> {
    Ok(DesktopStatus {
        supported: cfg!(windows),
        context_menu: menu_enabled()?,
        setup_completed: preferences(&state.paths.root)?.setup_completed,
    })
}
#[tauri::command]
pub(crate) fn desktop_integration_save(
    state: State<'_, AppState>,
    enabled: bool,
    complete_setup: bool,
) -> Result<DesktopStatus, String> {
    let _guard = state.data_maintenance.lock().map_err(|e| e.to_string())?;
    set_menu(enabled)?;
    if complete_setup {
        let mut file =
            tempfile::NamedTempFile::new_in(&state.paths.root).map_err(|e| e.to_string())?;
        file.write_all(br#"{"setupCompleted":true}"#)
            .map_err(|e| e.to_string())?;
        file.persist(state.paths.root.join("desktop-integration.json"))
            .map_err(|e| e.to_string())?;
    }
    drop(_guard);
    desktop_integration_status(state)
}
#[cfg(windows)]
fn menu_key() -> String {
    // Native tests exercise real registry APIs in a private key, never the user's menu.
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("ARC_RECALL_TEST_DATA_ROOT") {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        root.hash(&mut hash);
        return format!(
            r"Software\ArcRecall\TestIntegration\{:x}\shell\ArcRecall",
            hash.finish()
        );
    }
    r"Software\Classes\*\shell\ArcRecall".into()
}
#[cfg(windows)]
fn menu_enabled() -> Result<bool, String> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    match RegKey::predef(HKEY_CURRENT_USER).open_subkey(menu_key()) {
        Ok(key) => Ok(key.get_value::<String, _>("MUIVerb").ok().as_deref() == Some("ArcRecall")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}
#[cfg(windows)]
fn set_menu(enabled: bool) -> Result<(), String> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    let root = RegKey::predef(HKEY_CURRENT_USER);
    if !enabled {
        return match root.delete_subkey_all(menu_key()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = executable.to_str().ok_or("程序路径编码无效")?;
    let (key, _) = root.create_subkey(menu_key()).map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        key.set_value("MUIVerb", &"ArcRecall")?;
        key.set_value("Icon", &format!("\"{exe}\",0"))?;
        key.set_value("SubCommands", &"")?;
        for (action, label) in [
            ("open", "用 ArcRecall 打开"),
            ("queue", "加入解压队列"),
            ("check", "检查完整性"),
        ] {
            let (verb, _) = key.create_subkey(format!("shell\\{action}"))?;
            verb.set_value("", &label)?;
            verb.set_value("MultiSelectModel", &"Document")?;
            let (command, _) = verb.create_subkey("command")?;
            command.set_value("", &format!("\"{exe}\" --shell-action {action} -- \"%1\""))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = root.delete_subkey_all(menu_key());
    }
    result.map_err(|e| e.to_string())
}
#[cfg(not(windows))]
fn menu_enabled() -> Result<bool, String> {
    Ok(false)
}
#[cfg(not(windows))]
fn set_menu(enabled: bool) -> Result<(), String> {
    if enabled {
        Err("仅 Windows 支持资源管理器菜单。".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub(crate) fn desktop_launch_list(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<LaunchRequest>, String> {
    let inbox = state.paths.root.join("shell-inbox");
    if !inbox.exists() {
        return Ok(vec![]);
    }
    let mut requests = Vec::new();
    for entry in fs::read_dir(inbox).map_err(|e| e.to_string())?.take(1000) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json")
            || entry.metadata().map_err(|e| e.to_string())?.len() > 64 * 1024
        {
            continue;
        }
        if let Ok(request) = serde_json::from_slice::<LaunchRequest>(
            &fs::read(entry.path()).map_err(|e| e.to_string())?,
        ) {
            requests.push(request);
        }
    }
    let ids: Vec<_> = requests.iter().map(|r| r.id.clone()).collect();
    let mut previous = LAST_LAUNCHES.lock().map_err(|e| e.to_string())?;
    let newly_arrived = ids.iter().any(|id| !previous.contains(id));
    *previous = ids;
    if newly_arrived && let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(requests)
}
#[tauri::command]
pub(crate) fn desktop_launch_ack(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("启动请求无效".into());
    }
    let path = state
        .paths
        .root
        .join("shell-inbox")
        .join(format!("{id}.json"));
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn onboarding_remains_pending_after_first_launch_and_upgrades_skip_it() {
        let fresh = tempfile::tempdir().unwrap();
        drop(initialize(fresh.path(), vec![]).unwrap());
        assert!(!preferences(fresh.path()).unwrap().setup_completed);
        fs::write(fresh.path().join("settings.json"), "{}").unwrap();
        drop(initialize(fresh.path(), vec![]).unwrap());
        assert!(!preferences(fresh.path()).unwrap().setup_completed);
        let upgrade = tempfile::tempdir().unwrap();
        fs::write(upgrade.path().join("settings.json"), "{}").unwrap();
        drop(initialize(upgrade.path(), vec![]).unwrap());
        assert!(preferences(upgrade.path()).unwrap().setup_completed);
    }

    #[test]
    fn launch_arguments_preserve_literal_paths_and_reject_unknown_actions() {
        let path = std::env::temp_dir()
            .join("[测试分组] 中文目录")
            .join("加密归档.dll")
            .to_string_lossy()
            .into_owned();
        let args = vec![
            "app".into(),
            "--shell-action".into(),
            "queue".into(),
            "--".into(),
            path.clone(),
        ];
        assert_eq!(parse_launch(&args).unwrap().unwrap().path, path);
        let mut invalid = args;
        invalid[2] = "execute".into();
        assert!(parse_launch(&invalid).is_err());
    }
    #[test]
    fn second_instance_delivers_without_acquiring_store_lock() {
        let dir = tempfile::tempdir().unwrap();
        let first = initialize(dir.path(), vec![]).unwrap().unwrap();
        assert!(initialize(dir.path(), vec![]).unwrap().is_none());
        drop(first);
        assert!(initialize(dir.path(), vec![]).unwrap().is_some());
    }
}
