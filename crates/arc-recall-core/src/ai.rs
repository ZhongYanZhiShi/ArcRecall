use std::time::Duration;

use reqwest::blocking::{Client, RequestBuilder};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::settings::AiProviderKind;
use crate::tools::{CompressionError, sanitize_archive_base_name};

const AI_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_GENERATED_NAME_CHARACTERS: usize = 120;

#[derive(Clone)]
pub struct AiClientConfig {
    pub provider: AiProviderKind,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelInfo {
    pub id: String,
    pub owned_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter_size: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionTestResult {
    pub success: bool,
    pub message: String,
    pub model_count: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("{0}")]
    InvalidConfiguration(String),
    #[error("无法创建 AI 网络客户端：{0}")]
    Client(#[source] reqwest::Error),
    #[error("AI 请求失败：{0}")]
    Request(#[source] reqwest::Error),
    #[error("AI 服务返回 HTTP {status}：{message}")]
    Http { status: u16, message: String },
    #[error("无法解析 AI 服务响应：{0}")]
    Response(#[source] serde_json::Error),
    #[error("{0}")]
    InvalidGeneratedName(String),
}

pub fn list_ai_models(config: &AiClientConfig) -> Result<Vec<AiModelInfo>, AiError> {
    let base_url = validate_ai_base_url(&config.base_url)?;
    let client = build_client()?;
    let mut models = list_openai_compatible_models(&client, &base_url, config.api_key.as_deref())?;
    let metadata = match config.provider {
        AiProviderKind::Ollama => list_ollama_models(&client, &base_url, config.api_key.as_deref()),
        AiProviderKind::LmStudio => {
            list_lm_studio_models(&client, &base_url, config.api_key.as_deref())
        }
        AiProviderKind::Custom => return Ok(models),
    };
    if let Ok(metadata) = metadata {
        merge_model_metadata(&mut models, &metadata);
    }
    Ok(models)
}

fn list_openai_compatible_models(
    client: &Client,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<AiModelInfo>, AiError> {
    let body = fetch_json_body(client, endpoint_url(base_url, "models")?, api_key)?;
    parse_models_response(&body)
}

fn list_ollama_models(
    client: &Client,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<AiModelInfo>, AiError> {
    let body = fetch_json_body(client, service_endpoint_url(base_url, "api/tags")?, api_key)?;
    parse_ollama_models_response(&body)
}

fn list_lm_studio_models(
    client: &Client,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<AiModelInfo>, AiError> {
    let body = fetch_json_body(
        client,
        service_endpoint_url(base_url, "api/v1/models")?,
        api_key,
    )?;
    parse_lm_studio_models_response(&body)
}

fn fetch_json_body(
    client: &Client,
    url: reqwest::Url,
    api_key: Option<&str>,
) -> Result<String, AiError> {
    let request = with_auth(client.get(url).header(ACCEPT, "application/json"), api_key);
    let response = request.send().map_err(AiError::Request)?;
    let status = response.status();
    let body = response.text().map_err(AiError::Request)?;
    if !status.is_success() {
        return Err(AiError::Http {
            status: status.as_u16(),
            message: concise_body(&body),
        });
    }
    Ok(body)
}

pub fn test_ai_connection(config: &AiClientConfig) -> Result<AiConnectionTestResult, AiError> {
    let models = list_ai_models(config)?;
    Ok(AiConnectionTestResult {
        success: true,
        message: if models.is_empty() {
            "连接成功，但服务未返回可用模型。".into()
        } else {
            format!("连接成功，发现 {} 个模型。", models.len())
        },
        model_count: models.len(),
    })
}

pub fn generate_archive_name(
    config: &AiClientConfig,
    base_name: &str,
    prompt: &str,
) -> Result<String, AiError> {
    let base_url = validate_ai_base_url(&config.base_url)?;
    let model = config.model.trim();
    if model.is_empty() {
        return Err(AiError::InvalidConfiguration(
            "请先为 AI 配置选择或填写模型。".into(),
        ));
    }
    let input_name = base_name.trim();
    if input_name.is_empty() {
        return Err(AiError::InvalidConfiguration(
            "请先输入归档基础名称。".into(),
        ));
    }
    let rename_prompt = prompt.trim();
    if rename_prompt.is_empty() {
        return Err(AiError::InvalidConfiguration(
            "AI 重命名提示词不能为空。".into(),
        ));
    }

    let client = build_client()?;
    let body = chat_completion_body(model, input_name, rename_prompt);
    let request = with_auth(
        client
            .post(endpoint_url(&base_url, "chat/completions")?)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .json(&body),
        config.api_key.as_deref(),
    );
    let response = request.send().map_err(AiError::Request)?;
    let status = response.status();
    let response_body = response.text().map_err(AiError::Request)?;
    if !status.is_success() {
        return Err(AiError::Http {
            status: status.as_u16(),
            message: concise_body(&response_body),
        });
    }
    let content = parse_chat_response(&response_body)?;
    clean_generated_archive_name(&content)
}

pub fn validate_ai_base_url(value: &str) -> Result<String, AiError> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AiError::InvalidConfiguration(
            "AI 服务地址不能为空。".into(),
        ));
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| AiError::InvalidConfiguration("AI 服务地址不是有效的 HTTP(S) URL。".into()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AiError::InvalidConfiguration(
            "AI 服务地址必须使用有效的 http:// 或 https:// URL。".into(),
        ));
    }
    Ok(trimmed.into())
}

fn build_client() -> Result<Client, AiError> {
    Client::builder()
        .timeout(AI_REQUEST_TIMEOUT)
        .build()
        .map_err(AiError::Client)
}

fn endpoint_url(base_url: &str, endpoint: &str) -> Result<reqwest::Url, AiError> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|_| AiError::InvalidConfiguration("AI 服务地址不是有效的 HTTP(S) URL。".into()))?;
    let base_path = url.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}/{}", endpoint.trim_start_matches('/')));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn service_endpoint_url(base_url: &str, endpoint: &str) -> Result<reqwest::Url, AiError> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|_| AiError::InvalidConfiguration("AI 服务地址不是有效的 HTTP(S) URL。".into()))?;
    url.set_path(&format!("/{}", endpoint.trim_start_matches('/')));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn with_auth(request: RequestBuilder, api_key: Option<&str>) -> RequestBuilder {
    match api_key.map(str::trim).filter(|key| !key.is_empty()) {
        Some(api_key) => request.header(AUTHORIZATION, format!("Bearer {api_key}")),
        None => request,
    }
}

fn chat_completion_body(model: &str, base_name: &str, prompt: &str) -> serde_json::Value {
    json!({
        "model": model,
        "temperature": 0.2,
        "max_tokens": 80,
        "messages": [
            {
                "role": "system",
                "content": prompt
            },
            {
                "role": "user",
                "content": base_name
            }
        ]
    })
}

fn parse_models_response(body: &str) -> Result<Vec<AiModelInfo>, AiError> {
    #[derive(Deserialize)]
    struct ModelsResponse {
        #[serde(default)]
        data: Vec<ModelResponse>,
    }
    #[derive(Deserialize)]
    struct ModelResponse {
        id: String,
        #[serde(default)]
        owned_by: String,
    }

    let parsed = serde_json::from_str::<ModelsResponse>(body).map_err(AiError::Response)?;
    let mut models = parsed
        .data
        .into_iter()
        .filter_map(|model| {
            let id = model.id.trim().to_string();
            (!id.is_empty()).then_some(AiModelInfo {
                id,
                owned_by: model.owned_by.trim().to_string(),
                size_bytes: None,
                parameter_size: None,
            })
        })
        .collect::<Vec<_>>();
    sort_and_deduplicate_models(&mut models);
    Ok(models)
}

fn parse_ollama_models_response(body: &str) -> Result<Vec<AiModelInfo>, AiError> {
    #[derive(Deserialize)]
    struct ModelsResponse {
        #[serde(default)]
        models: Vec<ModelResponse>,
    }
    #[derive(Deserialize)]
    struct ModelResponse {
        #[serde(default)]
        name: String,
        #[serde(default)]
        model: String,
        size: Option<u64>,
        #[serde(default)]
        details: ModelDetails,
    }
    #[derive(Default, Deserialize)]
    struct ModelDetails {
        #[serde(default)]
        parameter_size: String,
    }

    let parsed = serde_json::from_str::<ModelsResponse>(body).map_err(AiError::Response)?;
    let mut models = parsed
        .models
        .into_iter()
        .filter_map(|model| {
            let id = if model.model.trim().is_empty() {
                model.name.trim()
            } else {
                model.model.trim()
            }
            .to_string();
            (!id.is_empty()).then_some(AiModelInfo {
                id,
                owned_by: String::new(),
                size_bytes: model.size.filter(|size| *size > 0),
                parameter_size: non_empty_string(model.details.parameter_size),
            })
        })
        .collect::<Vec<_>>();
    sort_and_deduplicate_models(&mut models);
    Ok(models)
}

fn parse_lm_studio_models_response(body: &str) -> Result<Vec<AiModelInfo>, AiError> {
    #[derive(Deserialize)]
    struct ModelsResponse {
        #[serde(default)]
        models: Vec<ModelResponse>,
    }
    #[derive(Deserialize)]
    struct ModelResponse {
        key: String,
        size_bytes: Option<u64>,
        params_string: Option<String>,
        #[serde(default)]
        loaded_instances: Vec<LoadedInstance>,
    }
    #[derive(Deserialize)]
    struct LoadedInstance {
        id: String,
    }

    let parsed = serde_json::from_str::<ModelsResponse>(body).map_err(AiError::Response)?;
    let mut models = Vec::new();
    for model in parsed.models {
        let mut ids = vec![model.key];
        ids.extend(
            model
                .loaded_instances
                .into_iter()
                .map(|instance| instance.id),
        );
        let size_bytes = model.size_bytes.filter(|size| *size > 0);
        let parameter_size = model.params_string.and_then(non_empty_string);
        models.extend(ids.into_iter().filter_map(|id| {
            let id = id.trim().to_string();
            (!id.is_empty()).then_some(AiModelInfo {
                id,
                owned_by: String::new(),
                size_bytes,
                parameter_size: parameter_size.clone(),
            })
        }));
    }
    sort_and_deduplicate_models(&mut models);
    Ok(models)
}

fn non_empty_string(value: String) -> Option<String> {
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn sort_and_deduplicate_models(models: &mut Vec<AiModelInfo>) {
    models.sort_by_key(|model| model.id.to_lowercase());
    models.dedup_by(|left, right| left.id == right.id);
}

fn merge_model_metadata(models: &mut [AiModelInfo], metadata: &[AiModelInfo]) {
    for model in models {
        if let Some(model_metadata) = metadata.iter().find(|candidate| candidate.id == model.id) {
            model.size_bytes = model_metadata.size_bytes;
            model
                .parameter_size
                .clone_from(&model_metadata.parameter_size);
        }
    }
}

fn parse_chat_response(body: &str) -> Result<String, AiError> {
    #[derive(Deserialize)]
    struct ChatResponse {
        choices: Vec<Choice>,
    }
    #[derive(Deserialize)]
    struct Choice {
        message: Message,
    }
    #[derive(Deserialize)]
    struct Message {
        content: Option<String>,
    }

    let parsed = serde_json::from_str::<ChatResponse>(body).map_err(AiError::Response)?;
    parsed
        .choices
        .into_iter()
        .find_map(|choice| choice.message.content)
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| AiError::InvalidGeneratedName("AI 未返回可用名称。".into()))
}

fn clean_generated_archive_name(value: &str) -> Result<String, AiError> {
    let without_fence = value
        .trim()
        .trim_start_matches("```text")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let first_line = without_fence
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim()
        .trim_matches(['"', '\'', '`']);
    if first_line.chars().count() > MAX_GENERATED_NAME_CHARACTERS {
        return Err(AiError::InvalidGeneratedName(
            "AI 返回的名称过长，请调整提示词后重试。".into(),
        ));
    }
    sanitize_archive_base_name(first_line).map_err(|error| match error {
        CompressionError::InvalidRequest(message) => AiError::InvalidGeneratedName(message),
        other => AiError::InvalidGeneratedName(other.to_string()),
    })
}

fn concise_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "服务未返回错误详情。".into()
    } else {
        trimmed.chars().take(500).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_openai_compatible_endpoints() {
        assert_eq!(
            endpoint_url("http://127.0.0.1:11434/v1", "models")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:11434/v1/models"
        );
        assert_eq!(
            endpoint_url("https://api.example.com/v1/", "/chat/completions")
                .unwrap()
                .as_str(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(
            service_endpoint_url("http://127.0.0.1:11434/v1", "api/tags")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:11434/api/tags"
        );
    }

    #[test]
    fn parses_and_sorts_model_list() {
        let models =
            parse_models_response(r#"{"data":[{"id":"zeta"},{"id":"alpha","owned_by":"local"}]}"#)
                .unwrap();
        assert_eq!(models[0].id, "alpha");
        assert_eq!(models[0].owned_by, "local");
        assert_eq!(models[0].size_bytes, None);
        assert_eq!(models[0].parameter_size, None);
        assert_eq!(models[1].id, "zeta");
    }

    #[test]
    fn parses_ollama_model_size_and_parameters() {
        let models = parse_ollama_models_response(
            r#"{
                "models": [{
                    "name": "gemma3:latest",
                    "model": "gemma3:latest",
                    "size": 3338801804,
                    "details": { "parameter_size": "4.3B" }
                }]
            }"#,
        )
        .unwrap();
        assert_eq!(models[0].id, "gemma3:latest");
        assert_eq!(models[0].size_bytes, Some(3_338_801_804));
        assert_eq!(models[0].parameter_size.as_deref(), Some("4.3B"));
    }

    #[test]
    fn parses_lm_studio_model_size_and_parameters() {
        let models = parse_lm_studio_models_response(
            r#"{
                "models": [{
                    "key": "google/gemma-4-26b-a4b",
                    "size_bytes": 17990911801,
                    "params_string": "26B-A4B"
                }]
            }"#,
        )
        .unwrap();
        assert_eq!(models[0].id, "google/gemma-4-26b-a4b");
        assert_eq!(models[0].size_bytes, Some(17_990_911_801));
        assert_eq!(models[0].parameter_size.as_deref(), Some("26B-A4B"));
    }

    #[test]
    fn enriches_openai_model_ids_from_lm_studio_loaded_instances() {
        let mut models = parse_models_response(
            r#"{"data":[{"id":"friendly-alias","owned_by":"organization_owner"}]}"#,
        )
        .unwrap();
        let metadata = parse_lm_studio_models_response(
            r#"{
                "models": [{
                    "key": "publisher/model",
                    "size_bytes": 4680000000,
                    "params_string": "7B",
                    "loaded_instances": [{ "id": "friendly-alias" }]
                }]
            }"#,
        )
        .unwrap();
        merge_model_metadata(&mut models, &metadata);
        assert_eq!(models[0].id, "friendly-alias");
        assert_eq!(models[0].owned_by, "organization_owner");
        assert_eq!(models[0].size_bytes, Some(4_680_000_000));
        assert_eq!(models[0].parameter_size.as_deref(), Some("7B"));
    }

    #[test]
    fn request_body_contains_only_prompt_and_user_name_as_content() {
        let body = chat_completion_body("model", "用户名称", "提示词");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["content"], "提示词");
        assert_eq!(messages[1]["content"], "用户名称");
        assert!(!body.to_string().contains("source"));
        assert!(!body.to_string().contains("path"));
    }

    #[test]
    fn cleans_fences_quotes_extension_and_invalid_characters() {
        assert_eq!(
            clean_generated_archive_name("```text\n\"项目:交付.zip\"\n```").unwrap(),
            "项目_交付"
        );
    }

    #[test]
    fn rejects_empty_or_overlong_generated_names() {
        assert!(clean_generated_archive_name("```").is_err());
        assert!(clean_generated_archive_name(&"a".repeat(121)).is_err());
    }

    #[test]
    fn parses_first_non_empty_chat_choice() {
        let content = parse_chat_response(
            r#"{"choices":[{"message":{"content":null}},{"message":{"content":"result"}}]}"#,
        )
        .unwrap();
        assert_eq!(content, "result");
    }
}
