use std::path::{Path, PathBuf};

use arc_recall_core::{
    AppSettings, FullEngineBundleInstallResult, FullEngineBundleManager, FullEngineBundleStatus,
    HashcatInstallResult, HashcatStatus, HashcatToolDownloader, JohnPerlStatus,
    RecoveryCapabilities, RecoveryToolPaths, probe_john_perl, probe_recovery_capabilities,
    resolve_tools_directory,
};
use tauri::State;

use crate::logging::LogLevel;
use crate::task_coordination::TaskStartReservation;
use crate::{AppState, ensure_no_active_archive_task, write_log};

fn hashcat_downloader(state: &AppState) -> Result<HashcatToolDownloader, String> {
    let settings = state.settings.lock().map_err(|error| error.to_string())?;
    let loaded = settings.load().map_err(|error| error.to_string())?;
    let tools = resolve_tools_directory(&state.paths.tools, &loaded.engine.tools_directory);
    Ok(HashcatToolDownloader::new(
        tools,
        state.paths.tools.clone(),
        loaded.engine.tools_directory.clone(),
        state.paths.temp.clone(),
    ))
}

pub(crate) fn full_bundle_manager(state: &AppState) -> Result<FullEngineBundleManager, String> {
    let settings = state.settings.lock().map_err(|error| error.to_string())?;
    let loaded = settings.load().map_err(|error| error.to_string())?;
    let tools = resolve_tools_directory(&state.paths.tools, &loaded.engine.tools_directory);
    Ok(FullEngineBundleManager::new(
        state.resource_dir.clone(),
        tools,
    ))
}

pub(crate) fn recovery_tool_paths(state: &AppState) -> Result<RecoveryToolPaths, String> {
    let manager = full_bundle_manager(state)?;
    let engine = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        settings.load().map_err(|error| error.to_string())?.engine
    };
    Ok(RecoveryToolPaths {
        seven_zip: manager.seven_zip_executable(),
        hashcat: configured_path_or(manager.hashcat_executable(), &engine.hashcat_path),
        john_tools_directory: configured_path_or(
            manager.john_tools_directory(),
            &engine.john_tools_directory,
        ),
        perl: configured_path_or(manager.perl_executable(), &engine.perl_path),
    })
}

#[tauri::command]
pub(crate) async fn tool_full_bundle_status(
    state: State<'_, AppState>,
) -> Result<FullEngineBundleStatus, String> {
    let manager = full_bundle_manager(&state)?;
    tauri::async_runtime::spawn_blocking(move || manager.status())
        .await
        .map_err(|error| format!("完整引擎探测任务失败：{error}"))
}

#[tauri::command]
pub(crate) async fn recovery_capabilities(
    state: State<'_, AppState>,
) -> Result<RecoveryCapabilities, String> {
    let tools = recovery_tool_paths(&state)?;
    tauri::async_runtime::spawn_blocking(move || probe_recovery_capabilities(&tools))
        .await
        .map_err(|error| format!("解密能力探测任务失败：{error}"))
}

#[tauri::command]
pub(crate) async fn tool_full_bundle_install(
    state: State<'_, AppState>,
) -> Result<FullEngineBundleInstallResult, String> {
    let _operation_reservation = TaskStartReservation::acquire(
        &state.archive_task_starting,
        "另一个归档或引擎任务正在进行，请稍后重试。",
    )?;
    ensure_no_active_archive_task(&state)?;
    write_log(
        &state.logger,
        LogLevel::Info,
        "engine",
        "engine.bundle_install_started",
        "完整引擎部署已开始。",
        std::iter::empty(),
    );
    let manager = full_bundle_manager(&state)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.install().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("完整引擎安装任务失败：{error}"))??;

    if result.success {
        let store = state.settings.lock().map_err(|error| error.to_string())?;
        let mut settings = store.load().map_err(|error| error.to_string())?;
        settings.engine.hashcat_path = result.hashcat_path.clone();
        settings.engine.john_tools_directory = result.john_tools_directory.clone();
        settings.engine.perl_path = result.perl_path.clone();
        store.save(&settings).map_err(|error| error.to_string())?;
    }
    write_log(
        &state.logger,
        if result.success {
            LogLevel::Info
        } else {
            LogLevel::Warn
        },
        "engine",
        if result.success {
            "engine.bundle_install_completed"
        } else {
            "engine.bundle_install_incomplete"
        },
        if result.success {
            "完整引擎部署已完成。"
        } else {
            "完整引擎部署未完成。"
        },
        std::iter::empty(),
    );
    Ok(result)
}

#[tauri::command]
pub(crate) fn tool_hashcat_status(state: State<'_, AppState>) -> Result<HashcatStatus, String> {
    let configured = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        settings
            .load()
            .map_err(|error| error.to_string())?
            .engine
            .hashcat_path
    };
    Ok(hashcat_downloader(&state)?.status(&configured))
}

#[tauri::command]
pub(crate) async fn tool_hashcat_download(
    state: State<'_, AppState>,
) -> Result<HashcatInstallResult, String> {
    let _operation_reservation = TaskStartReservation::acquire(
        &state.archive_task_starting,
        "另一个归档或引擎任务正在进行，请稍后重试。",
    )?;
    ensure_no_active_archive_task(&state)?;
    write_log(
        &state.logger,
        LogLevel::Info,
        "engine",
        "engine.hashcat_install_started",
        "Hashcat 安装已开始。",
        std::iter::empty(),
    );
    let downloader = hashcat_downloader(&state)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        downloader.install().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Hashcat 安装任务失败：{error}"))??;
    if result.success && !result.executable_path.is_empty() {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        settings
            .save_hashcat_path(&result.executable_path)
            .map_err(|error| error.to_string())?;
    }
    write_log(
        &state.logger,
        if result.success {
            LogLevel::Info
        } else {
            LogLevel::Warn
        },
        "engine",
        if result.success {
            "engine.hashcat_install_completed"
        } else {
            "engine.hashcat_install_incomplete"
        },
        if result.success {
            "Hashcat 安装已完成。"
        } else {
            "Hashcat 安装未完成。"
        },
        std::iter::empty(),
    );
    Ok(result)
}

#[tauri::command]
pub(crate) fn tool_set_tools_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<AppSettings, String> {
    let trimmed = path.trim();
    if !trimmed.is_empty() {
        let path = Path::new(trimmed);
        if trimmed.contains("..") {
            return Err("工具目录路径不能包含 \"..\"".into());
        }
        if !path.is_absolute() {
            return Err("请填写绝对路径作为公共工具目录".into());
        }
        std::fs::create_dir_all(path).map_err(|error| format!("无法创建工具目录：{error}"))?;
    }
    let settings = state.settings.lock().map_err(|error| error.to_string())?;
    settings
        .save_tools_directory(trimmed)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn tool_john_perl_status(
    state: State<'_, AppState>,
) -> Result<JohnPerlStatus, String> {
    let (john, perl) = {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        let loaded = settings.load().map_err(|error| error.to_string())?;
        (loaded.engine.john_tools_directory, loaded.engine.perl_path)
    };
    tauri::async_runtime::spawn_blocking(move || probe_john_perl(&john, &perl))
        .await
        .map_err(|error| format!("John / Perl 探测任务失败：{error}"))
}

#[tauri::command]
pub(crate) async fn tool_set_john_perl(
    state: State<'_, AppState>,
    john_tools_directory: String,
    perl_path: String,
) -> Result<JohnPerlStatus, String> {
    let john = john_tools_directory.trim();
    let perl = perl_path.trim();
    if !john.is_empty() {
        if john.contains("..") {
            return Err("John 工具目录不能包含 \"..\"".into());
        }
        let path = Path::new(john);
        if !path.is_absolute() {
            return Err("John 工具目录请使用绝对路径".into());
        }
    }
    if !perl.is_empty() {
        if perl.contains("..") {
            return Err("perl 路径不能包含 \"..\"".into());
        }
        let path = Path::new(perl);
        if !path.is_absolute() {
            return Err("perl 路径请使用绝对路径".into());
        }
    }
    {
        let settings = state.settings.lock().map_err(|error| error.to_string())?;
        settings
            .save_john_perl(john, perl)
            .map_err(|error| error.to_string())?;
    }
    let john = john.to_string();
    let perl = perl.to_string();
    tauri::async_runtime::spawn_blocking(move || probe_john_perl(&john, &perl))
        .await
        .map_err(|error| format!("John / Perl 探测任务失败：{error}"))
}

fn configured_path_or(default: PathBuf, configured: &str) -> PathBuf {
    let configured = configured.trim();
    if configured.is_empty() {
        default
    } else {
        PathBuf::from(configured)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::configured_path_or;

    #[test]
    fn configured_recovery_path_overrides_bundle_default() {
        assert_eq!(
            configured_path_or(
                PathBuf::from(r"C:\ArcRecall\tools\hashcat.exe"),
                r" D:\Shared\hashcat.exe "
            ),
            PathBuf::from(r"D:\Shared\hashcat.exe")
        );
        assert_eq!(
            configured_path_or(PathBuf::from(r"C:\ArcRecall\tools\john"), "  "),
            PathBuf::from(r"C:\ArcRecall\tools\john")
        );
    }
}
