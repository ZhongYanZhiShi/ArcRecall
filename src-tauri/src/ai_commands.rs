use std::sync::atomic::{AtomicU64, Ordering};

use arc_recall_core::{
    AiClientConfig, AiConnectionTestResult, AiModelInfo, AiProfile, AiProviderKind, AiSettings,
    generate_archive_name, list_ai_models, test_ai_connection, validate_ai_base_url,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::logging::LogLevel;
use crate::{AppState, current_time_ms, write_log};

static AI_PROFILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const AI_KEYRING_SERVICE: &str = "ArcRecall AI";
const MAX_AI_PROFILES: usize = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProfileView {
    #[serde(flatten)]
    profile: AiProfile,
    has_api_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettingsView {
    profiles: Vec<AiProfileView>,
    active_profile_id: String,
    rename_prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiProfileUpsertRequest {
    id: Option<String>,
    name: String,
    provider: AiProviderKind,
    base_url: String,
    model: String,
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
    #[serde(default)]
    make_active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiClientDraftRequest {
    profile_id: Option<String>,
    provider: AiProviderKind,
    base_url: String,
    model: String,
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettingsUpdateRequest {
    active_profile_id: String,
    rename_prompt: String,
}

#[tauri::command]
pub(crate) fn ai_profiles_list(state: State<'_, AppState>) -> Result<AiSettingsView, String> {
    load_ai_settings_view(&state)
}

#[tauri::command]
pub(crate) fn ai_profile_upsert(
    state: State<'_, AppState>,
    request: AiProfileUpsertRequest,
) -> Result<AiSettingsView, String> {
    let requested_api_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let clear_api_key = request.clear_api_key;
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(next_ai_profile_id);
    if !is_safe_ai_profile_id(&id) {
        return Err("AI 配置标识无效。".into());
    }
    let mut profile = AiProfile {
        id: id.clone(),
        name: request.name,
        provider: request.provider,
        base_url: request.base_url,
        model: request.model,
    };
    profile.normalize();
    if profile.name.is_empty() {
        return Err("AI 配置名称不能为空。".into());
    }
    if profile.name.chars().count() > 64 {
        return Err("AI 配置名称不能超过 64 个字符。".into());
    }
    if profile.base_url.is_empty() {
        profile.base_url = profile.provider.default_base_url().into();
    }
    profile.base_url =
        validate_ai_base_url(&profile.base_url).map_err(|error| error.to_string())?;
    if profile.model.is_empty() {
        profile.model = profile.provider.default_model().into();
    }

    let previous_settings = {
        let store = state.settings.lock().map_err(|error| error.to_string())?;
        let mut settings = store.load().map_err(|error| error.to_string())?;
        let previous_settings = settings.clone();
        if let Some(existing) = settings
            .ai
            .profiles
            .iter_mut()
            .find(|candidate| candidate.id == id)
        {
            *existing = profile;
        } else {
            if settings.ai.profiles.len() >= MAX_AI_PROFILES {
                return Err(format!("最多可保存 {MAX_AI_PROFILES} 个 AI 配置。"));
            }
            settings.ai.profiles.push(profile);
        }
        if request.make_active || settings.ai.active_profile_id.is_empty() {
            settings.ai.active_profile_id = id.clone();
        }
        store.save(&settings).map_err(|error| error.to_string())?;
        previous_settings
    };

    let credential_result = if clear_api_key {
        delete_ai_api_key(&id)
    } else if let Some(api_key) = requested_api_key.as_deref() {
        set_ai_api_key(&id, api_key)
    } else {
        Ok(())
    };
    if let Err(credential_error) = credential_result {
        let rollback_result = state
            .settings
            .lock()
            .map_err(|error| error.to_string())?
            .save(&previous_settings)
            .map_err(|error| error.to_string());
        return Err(match rollback_result {
            Ok(()) => format!("{credential_error} 配置更改已回滚，可修复凭据存储后重试。"),
            Err(rollback_error) => format!("{credential_error} 同时无法回滚配置：{rollback_error}"),
        });
    }
    write_log(
        &state.logger,
        LogLevel::Info,
        "ai",
        "ai.profile_saved",
        "AI 配置已保存。",
        [("profile_id".into(), id)],
    );
    load_ai_settings_view(&state)
}

#[tauri::command]
pub(crate) fn ai_profile_delete(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<AiSettingsView, String> {
    let profile_id = profile_id.trim();
    if profile_id.is_empty() {
        return Err("AI 配置标识不能为空。".into());
    }
    let previous_settings = {
        let store = state.settings.lock().map_err(|error| error.to_string())?;
        let mut settings = store.load().map_err(|error| error.to_string())?;
        let previous_settings = settings.clone();
        let original_count = settings.ai.profiles.len();
        settings
            .ai
            .profiles
            .retain(|profile| profile.id != profile_id);
        if settings.ai.profiles.len() == original_count {
            return Err("未找到要删除的 AI 配置。".into());
        }
        if settings.ai.active_profile_id == profile_id {
            settings.ai.active_profile_id = settings
                .ai
                .profiles
                .first()
                .map(|profile| profile.id.clone())
                .unwrap_or_default();
        }
        store.save(&settings).map_err(|error| error.to_string())?;
        previous_settings
    };
    if let Err(credential_error) = delete_ai_api_key(profile_id) {
        let rollback_result = state
            .settings
            .lock()
            .map_err(|error| error.to_string())?
            .save(&previous_settings)
            .map_err(|error| error.to_string());
        return Err(match rollback_result {
            Ok(()) => format!("{credential_error} 配置删除已回滚，可稍后重试。"),
            Err(rollback_error) => format!("{credential_error} 同时无法回滚配置：{rollback_error}"),
        });
    }
    write_log(
        &state.logger,
        LogLevel::Info,
        "ai",
        "ai.profile_deleted",
        "AI 配置已删除。",
        [("profile_id".into(), profile_id.into())],
    );
    load_ai_settings_view(&state)
}

#[tauri::command]
pub(crate) fn ai_settings_update(
    state: State<'_, AppState>,
    request: AiSettingsUpdateRequest,
) -> Result<AiSettingsView, String> {
    let prompt = request.rename_prompt.trim();
    if prompt.is_empty() {
        return Err("AI 重命名提示词不能为空。".into());
    }
    if prompt.chars().count() > 2_000 {
        return Err("AI 重命名提示词不能超过 2000 个字符。".into());
    }
    {
        let store = state.settings.lock().map_err(|error| error.to_string())?;
        let mut settings = store.load().map_err(|error| error.to_string())?;
        let active_id = request.active_profile_id.trim();
        if !active_id.is_empty()
            && !settings
                .ai
                .profiles
                .iter()
                .any(|profile| profile.id == active_id)
        {
            return Err("选择的 AI 配置不存在。".into());
        }
        settings.ai.active_profile_id = active_id.into();
        settings.ai.rename_prompt = prompt.into();
        store.save(&settings).map_err(|error| error.to_string())?;
    }
    write_log(
        &state.logger,
        LogLevel::Info,
        "ai",
        "ai.settings_saved",
        "AI 重命名设置已保存。",
        std::iter::empty(),
    );
    load_ai_settings_view(&state)
}

#[tauri::command]
pub(crate) async fn ai_models_list(
    request: AiClientDraftRequest,
) -> Result<Vec<AiModelInfo>, String> {
    let config = resolve_ai_client_draft_config(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        list_ai_models(&config).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("AI 模型列表任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn ai_connection_test(
    request: AiClientDraftRequest,
) -> Result<AiConnectionTestResult, String> {
    let config = resolve_ai_client_draft_config(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        test_ai_connection(&config).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("AI 连接测试任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn ai_generate_archive_name(
    state: State<'_, AppState>,
    base_name: String,
    profile_id: Option<String>,
    prompt: Option<String>,
) -> Result<String, String> {
    let (config, rename_prompt, provider) = {
        let store = state.settings.lock().map_err(|error| error.to_string())?;
        let settings = store.load().map_err(|error| error.to_string())?;
        let selected_id = profile_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .unwrap_or(&settings.ai.active_profile_id);
        let profile = settings
            .ai
            .profiles
            .iter()
            .find(|profile| profile.id == selected_id)
            .ok_or_else(|| "尚未配置可用的 AI 模型，请先前往设置。".to_string())?;
        let api_key = get_ai_api_key(&profile.id)?;
        (
            AiClientConfig {
                provider: profile.provider,
                base_url: profile.base_url.clone(),
                model: profile.model.clone(),
                api_key,
            },
            prompt
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&settings.ai.rename_prompt)
                .to_string(),
            profile.provider,
        )
    };
    let input_character_count = base_name.chars().count();
    let result = tauri::async_runtime::spawn_blocking(move || {
        generate_archive_name(&config, &base_name, &rename_prompt)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("AI 重命名任务失败：{error}"))?;
    write_log(
        &state.logger,
        if result.is_ok() {
            LogLevel::Info
        } else {
            LogLevel::Warn
        },
        "ai",
        if result.is_ok() {
            "ai.rename_completed"
        } else {
            "ai.rename_failed"
        },
        if result.is_ok() {
            "AI 归档重命名已完成。"
        } else {
            "AI 归档重命名失败。"
        },
        [
            (
                "provider".into(),
                format!("{provider:?}").to_ascii_lowercase(),
            ),
            (
                "input_character_count".into(),
                input_character_count.to_string(),
            ),
        ],
    );
    result
}

fn load_ai_settings_view(state: &AppState) -> Result<AiSettingsView, String> {
    let ai = {
        let store = state.settings.lock().map_err(|error| error.to_string())?;
        store.load().map_err(|error| error.to_string())?.ai
    };
    ai_settings_view(ai)
}

fn ai_settings_view(ai: AiSettings) -> Result<AiSettingsView, String> {
    let profiles = ai
        .profiles
        .into_iter()
        .map(|profile| {
            let has_api_key = get_ai_api_key(&profile.id)?.is_some();
            Ok(AiProfileView {
                profile,
                has_api_key,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(AiSettingsView {
        profiles,
        active_profile_id: ai.active_profile_id,
        rename_prompt: ai.rename_prompt,
    })
}

fn resolve_ai_client_draft_config(request: AiClientDraftRequest) -> Result<AiClientConfig, String> {
    let supplied_api_key = request
        .api_key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let api_key = if supplied_api_key.is_some() || request.clear_api_key {
        supplied_api_key
    } else if let Some(profile_id) = request
        .profile_id
        .as_deref()
        .map(str::trim)
        .filter(|profile_id| !profile_id.is_empty())
    {
        get_ai_api_key(profile_id)?
    } else {
        None
    };
    Ok(AiClientConfig {
        provider: request.provider,
        base_url: request.base_url,
        model: request.model,
        api_key,
    })
}

fn ai_keyring_entry(profile_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(AI_KEYRING_SERVICE, profile_id)
        .map_err(|error| format!("无法访问系统凭据存储：{error}"))
}

fn get_ai_api_key(profile_id: &str) -> Result<Option<String>, String> {
    match ai_keyring_entry(profile_id)?.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统凭据存储：{error}")),
    }
}

fn set_ai_api_key(profile_id: &str, api_key: &str) -> Result<(), String> {
    ai_keyring_entry(profile_id)?
        .set_password(api_key)
        .map_err(|error| format!("无法写入系统凭据存储：{error}"))
}

fn delete_ai_api_key(profile_id: &str) -> Result<(), String> {
    match ai_keyring_entry(profile_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除系统凭据：{error}")),
    }
}

fn is_safe_ai_profile_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn next_ai_profile_id() -> String {
    let timestamp = current_time_ms();
    let sequence = AI_PROFILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("ai-{timestamp}-{sequence}")
}

#[cfg(test)]
mod tests {
    use super::is_safe_ai_profile_id;

    #[test]
    fn validates_ai_profile_identifiers() {
        assert!(is_safe_ai_profile_id("ai-123_local"));
        assert!(!is_safe_ai_profile_id(""));
        assert!(!is_safe_ai_profile_id("profile/with/path"));
        assert!(!is_safe_ai_profile_id("配置"));
    }
}
