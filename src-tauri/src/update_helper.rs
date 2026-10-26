//! A copied executable runs a minimal updater UI, independent of the app/database.
//! Only signed NSIS packages are executed. The installer never owns application restart.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    System::Threading::{CREATE_NO_WINDOW, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

const REQUEST: &str = "request.json";
const STATUS: &str = "status.json";
const STARTED: &str = "started.json";
const PACKAGE: &str = "installer.exe";

#[derive(Clone, Serialize, Deserialize)]
struct Request {
    parent_pid: u32,
    application: PathBuf,
    version: String,
    manifest: serde_json::Value,
    theme: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    helper_pid: u32,
    phase: String,
    version: String,
    theme: String,
    message: String,
    error: Option<String>,
    retryable: bool,
    preview: bool,
}

struct Helper {
    directory: PathBuf,
    request: Option<Request>,
    parent: Option<OwnedHandle>,
    progress: Mutex<Progress>,
    running: AtomicBool,
    installed: AtomicBool,
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("无效的更新目录。")?)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    serde_json::from_reader(file.take(1024 * 1024)).map_err(|e| e.to_string())
}

impl Helper {
    fn publish(&self, phase: &str, message: &str, error: Option<String>) -> Result<(), String> {
        let mut progress = self.progress.lock().map_err(|e| e.to_string())?;
        progress.phase = phase.into();
        progress.message = message.into();
        progress.retryable = phase == "failed";
        progress.error = error;
        write_json(&self.directory.join(STATUS), &*progress)
    }
}

fn hidden_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    command
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

/// Return only after the independent WebView has loaded and the package was reverified.
pub(crate) fn prepare(
    app: &AppHandle,
    update: &Update,
    bytes: &[u8],
    theme: &str,
) -> Result<(), String> {
    update
        .verify(bytes)
        .map_err(|e| format!("更新包校验失败：{e}"))?;
    let application = std::env::current_exe()
        .and_then(dunce::canonicalize)
        .map_err(|e| e.to_string())?;
    let install_dir = application.parent().ok_or("无法确定安装目录。")?;
    // Quiet NSIS must have permission before the user loses the main window.
    tempfile::NamedTempFile::new_in(install_dir).map_err(|_| {
        "当前安装目录不可写，请使用安装包手动更新或以管理员身份启动后重试。".to_string()
    })?;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("update-sessions");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let session = tempfile::Builder::new()
        .prefix("session-")
        .tempdir_in(&root)
        .map_err(|e| e.to_string())?;
    let directory = session.path();
    fs::write(directory.join(PACKAGE), bytes).map_err(|e| e.to_string())?;
    write_json(
        &directory.join(REQUEST),
        &Request {
            parent_pid: std::process::id(),
            application: application.clone(),
            version: update.version.clone(),
            manifest: update.raw_json.clone(),
            theme: if theme == "light" { "light" } else { "dark" }.into(),
        },
    )?;
    let helper = directory.join("ArcRecall-update.exe");
    fs::copy(&application, &helper).map_err(|e| format!("无法准备更新程序：{e}"))?;
    let mut child = hidden_command(&helper)
        .arg("--update-helper")
        .arg(directory)
        .env_remove("WEBVIEW2_USER_DATA_FOLDER")
        .env_remove("ARC_RECALL_UPDATE_SESSION")
        .spawn()
        .map_err(|e| format!("无法启动更新窗口：{e}"))?;
    let result = wait_for_helper(&mut child, directory, Duration::from_secs(45));
    if result.is_ok() {
        let _ = session.keep();
    } else {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn wait_for_helper(child: &mut Child, directory: &Path, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("更新窗口未能启动，当前应用将保持打开。".into());
        }
        if let Ok(progress) = read_json::<Progress>(&directory.join(STATUS)) {
            if progress.phase == "waiting" {
                return Ok(());
            }
            if progress.phase == "failed" {
                return Err(progress.error.unwrap_or(progress.message));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("更新窗口启动超时，当前应用将保持打开，请重试。".into())
}

pub(crate) fn dispatch() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    let preview = cfg!(debug_assertions)
        && args
            .get(1)
            .is_some_and(|arg| arg == "--update-helper-preview");
    if !preview && args.get(1).is_none_or(|arg| arg != "--update-helper") {
        return false;
    }
    let result = if preview {
        let directory = tempfile::Builder::new()
            .prefix("arcrecall-update-preview-")
            .tempdir()
            .expect("preview directory");
        run(
            directory.path().to_owned(),
            true,
            args.get(2).and_then(|arg| arg.to_str()).unwrap_or("dark"),
        )
    } else if let Some(directory) = args.get(2) {
        run(PathBuf::from(directory), false, "dark")
    } else {
        Err("缺少更新会话。".into())
    };
    if let Err(error) = result {
        eprintln!("ArcRecall update: {error}");
    }
    true
}

fn run(directory: PathBuf, preview: bool, preview_theme: &str) -> Result<(), String> {
    let request: Option<Request> = if preview {
        None
    } else {
        Some(read_json(&directory.join(REQUEST))?)
    };
    let parent = if let Some(request) = &request {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, request.parent_pid) };
        if handle.is_null() {
            return Err("无法连接原应用，请从应用内重新发起更新。".into());
        }
        Some(unsafe { OwnedHandle::from_raw_handle(handle) })
    } else {
        None
    };
    let state = Arc::new(Helper {
        directory: directory.clone(),
        parent,
        progress: Mutex::new(Progress {
            helper_pid: std::process::id(),
            phase: "preparing".into(),
            version: request
                .as_ref()
                .map(|r| r.version.clone())
                .unwrap_or_else(|| "预览".into()),
            theme: request
                .as_ref()
                .map(|r| r.theme.clone())
                .unwrap_or_else(|| preview_theme.into()),
            message: "正在准备更新…".into(),
            error: None,
            retryable: false,
            preview,
        }),
        request,
        running: AtomicBool::new(false),
        installed: AtomicBool::new(false),
    });
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let window_theme = if state.progress.lock().unwrap().theme == "light" {
        tauri::Theme::Light
    } else {
        tauri::Theme::Dark
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .register_uri_scheme_protocol("arc-update", |_ctx, request| {
            let (mime, body) = match request.uri().path() {
                "/style.css" => ("text/css", include_str!("../update-ui/style.css")),
                "/main.js" => ("text/javascript", include_str!("../update-ui/main.js")),
                "/" | "/index.html" => ("text/html", include_str!("../update-ui/index.html")),
                _ => ("text/plain", "Not found"),
            };
            tauri::http::Response::builder().header("Content-Type", format!("{mime}; charset=utf-8"))
                .header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'")
                .body(body.as_bytes().to_vec()).unwrap()
        })
        .invoke_handler(tauri::generate_handler![helper_status, helper_start, helper_close])
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "update", tauri::WebviewUrl::CustomProtocol("arc-update://localhost/index.html".parse()?))
                .title("ArcRecall · 更新").inner_size(520.0, 420.0).resizable(false).maximizable(false).center()
                .theme(Some(window_theme))
                .data_directory(directory.join("webview"))
                .on_navigation(|url| (url.host_str() == Some("arc-update.localhost") && url.scheme() == "http") || (url.host_str() == Some("localhost") && url.scheme() == "arc-update"))
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.state::<Arc<Helper>>().running.load(Ordering::Acquire) {
                api.prevent_close();
            }
        })
        .run(context).map_err(|e| e.to_string())
}

#[tauri::command]
fn helper_status(state: State<'_, Arc<Helper>>) -> Result<Progress, String> {
    state
        .progress
        .lock()
        .map(|status| status.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn helper_close(app: AppHandle, state: State<'_, Arc<Helper>>) -> Result<(), String> {
    if state.running.load(Ordering::Acquire) {
        return Err("更新正在进行，请等待完成。".into());
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn helper_start(app: AppHandle, state: State<'_, Arc<Helper>>) {
    if !state
        .progress
        .lock()
        .is_ok_and(|progress| matches!(progress.phase.as_str(), "preparing" | "failed"))
    {
        return;
    }
    if state.running.swap(true, Ordering::AcqRel) {
        return;
    }
    let helper = Arc::clone(&state);
    std::thread::spawn(move || {
        if helper.request.is_none() {
            let _ = helper.publish("installing", "界面预览 · 不会执行安装", None);
            helper.running.store(false, Ordering::Release);
            return;
        }
        if let Err(error) = execute(&app, &helper) {
            let _ = helper.publish("failed", "更新未完成", Some(error));
        }
        helper.running.store(false, Ordering::Release);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waiting_child() -> Child {
        hidden_command(Path::new("powershell.exe"))
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .spawn()
            .unwrap()
    }

    fn progress(phase: &str) -> Progress {
        Progress {
            helper_pid: std::process::id(),
            phase: phase.into(),
            version: "2.0.0".into(),
            theme: "dark".into(),
            message: "测试阶段".into(),
            error: None,
            retryable: false,
            preview: true,
        }
    }

    #[test]
    fn handoff_requires_ready_signal_and_reports_failure_without_exiting_parent() {
        let root = tempfile::Builder::new()
            .prefix("[测试分组] 更新会话 ")
            .tempdir()
            .unwrap();
        let mut child = waiting_child();
        assert!(wait_for_helper(&mut child, root.path(), Duration::from_millis(100)).is_err());
        assert!(child.try_wait().unwrap().is_none());
        write_json(&root.path().join(STATUS), &progress("verifying")).unwrap();
        assert!(wait_for_helper(&mut child, root.path(), Duration::from_millis(100)).is_err());
        write_json(&root.path().join(STATUS), &progress("waiting")).unwrap();
        assert!(wait_for_helper(&mut child, root.path(), Duration::from_secs(1)).is_ok());
        let mut failed = progress("failed");
        failed.error = Some("签名校验失败".into());
        write_json(&root.path().join(STATUS), &failed).unwrap();
        assert_eq!(
            wait_for_helper(&mut child, root.path(), Duration::from_secs(1)).unwrap_err(),
            "签名校验失败"
        );
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(wait_for_helper(&mut child, root.path(), Duration::from_secs(1)).is_err());
    }

    #[test]
    fn installer_is_held_against_changes_while_running() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("测试安装包.exe");
        fs::write(&path, b"fixture").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(fs::write(&path, b"changed").is_err());
        assert!(fs::remove_file(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"fixture");
        drop(lock);
        fs::remove_file(&path).unwrap();
    }
}

fn verified_package(app: &AppHandle, helper: &Helper) -> Result<File, String> {
    let request = helper.request.as_ref().ok_or("缺少更新信息。")?;
    let native = app.updater().map_err(|e| e.to_string())?;
    let update = native
        .restore_update(request.manifest.clone())
        .map_err(|e| e.to_string())?
        .ok_or("该版本已不需要更新。")?;
    if update.version != request.version {
        return Err("更新版本信息不一致。".into());
    }
    // Deny writes/deletion until the verified installer exits (including during retries).
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(helper.directory.join(PACKAGE))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    update
        .verify(&bytes)
        .map_err(|e| format!("更新包签名或版本校验失败，请重新下载：{e}"))?;
    if !bytes.starts_with(b"MZ") {
        return Err("更新包不是 Windows EXE 安装程序。".into());
    }
    Ok(file)
}

fn execute(app: &AppHandle, helper: &Helper) -> Result<(), String> {
    let request = helper.request.as_ref().ok_or("缺少更新信息。")?;
    if !helper.installed.load(Ordering::Acquire) {
        helper.publish("verifying", "正在验证更新包", None)?;
        let package_lock = verified_package(app, helper)?;
        helper.publish("waiting", "正在关闭 ArcRecall", None)?;
        let parent = helper.parent.as_ref().ok_or("无法确认原应用状态。")?;
        if unsafe { WaitForSingleObject(parent.as_raw_handle(), 60_000) } != WAIT_OBJECT_0 {
            return Err("原应用尚未退出，未执行安装。请关闭原应用后重试。".into());
        }
        helper.publish("installing", "正在安装新版，请稍候", None)?;
        let directory = request.application.parent().ok_or("无效的安装目录。")?;
        let mut installer = hidden_command(&helper.directory.join(PACKAGE));
        installer.arg("/S").arg("/UPDATE").arg("/NS");
        // NSIS requires /D to be the final, unquoted argument, even with spaces.
        installer.raw_arg(format!("/D={}", directory.display()));
        let result = installer
            .status()
            .map_err(|e| format!("无法启动安装程序：{e}"))?;
        drop(package_lock);
        if !result.success() {
            return Err(format!(
                "安装程序返回错误 {}。可重试；若持续失败，请使用正式安装包修复。",
                result.code().unwrap_or(-1)
            ));
        }
        helper.installed.store(true, Ordering::Release);
        let _ = fs::remove_file(helper.directory.join(PACKAGE));
    }
    helper.publish("starting", "正在启动新版 ArcRecall", None)?;
    let _ = fs::remove_file(helper.directory.join(STARTED));
    let mut child = hidden_command(&request.application)
        .env("ARC_RECALL_UPDATE_SESSION", &helper.directory)
        .env_remove("WEBVIEW2_USER_DATA_FOLDER")
        .spawn()
        .map_err(|e| format!("安装已完成，但启动失败：{e}。请重试启动。"))?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if let Ok(version) = read_json::<String>(&helper.directory.join(STARTED))
            && version == request.version
        {
            helper.publish("complete", "更新完成", None)?;
            app.exit(0);
            return Ok(());
        }
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("安装已完成，但新版启动后退出。请重试启动或使用正式安装包修复。".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Do not kill a possibly healthy new app or launch a duplicate on retry.
    helper.publish(
        "unconfirmed",
        "已启动新版，但尚未收到就绪确认",
        Some("请检查新版窗口是否正常打开。可以关闭此更新窗口；不会再次安装或重复启动应用。".into()),
    )?;
    Ok(())
}

pub(crate) fn acknowledge_start(app: &AppHandle) -> Result<(), String> {
    let Some(directory) = std::env::var_os("ARC_RECALL_UPDATE_SESSION") else {
        return Ok(());
    };
    let directory = dunce::canonicalize(directory).map_err(|e| e.to_string())?;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("update-sessions");
    let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
    if directory.parent() != Some(root.as_path()) {
        return Err("无效的更新会话目录。".into());
    }
    let request: Request = read_json(&directory.join(REQUEST))?;
    let application = std::env::current_exe()
        .and_then(dunce::canonicalize)
        .map_err(|e| e.to_string())?;
    if request.application != application
        || request.version != app.package_info().version.to_string()
    {
        return Err("启动的程序或版本与更新目标不一致。".into());
    }
    let progress: Progress = read_json(&directory.join(STATUS))?;
    write_json(&directory.join(STARTED), &request.version)?;
    static CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);
    if !CLEANUP_STARTED.swap(true, Ordering::AcqRel) {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, progress.helper_pid) };
        if !handle.is_null() {
            let helper = unsafe { OwnedHandle::from_raw_handle(handle) };
            std::thread::spawn(move || {
                if unsafe { WaitForSingleObject(helper.as_raw_handle(), 120_000) } != WAIT_OBJECT_0
                {
                    return;
                }
                // This exact direct child of our cache root was validated above.
                // WebView children may need a moment to release their profile files.
                for _ in 0..10 {
                    if fs::remove_dir_all(&directory).is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            });
        }
    }
    Ok(())
}
