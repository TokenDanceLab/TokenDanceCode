use super::{tool_result_payload, validate_model};
use crate::{
    ModelProvider, ProviderConfig, ProviderError, ProviderProtocol, ProviderRequest,
    ProviderResponse,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::env;

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const TRANSPORT_ENABLE_ENV: &str = "TOKENDANCE_GATEWAY_HTTP_TRANSPORT";
const GATEWAY_API_KEY_ENV: &str = "TOKENDANCE_GATEWAY_API_KEY";
const OPENAI_API_KEY_ENV: &str = "OPENAI_API_KEY";

#[derive(Debug, Clone)]
pub struct OpenAiChatCompletionsProvider {
    config: ProviderConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiChatCompletionsRequest {
    pub model: String,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    pub tool_choice: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequestConfig {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HttpTransportMode {
    Disabled,
    Enabled,
}

impl HttpTransportMode {
    fn from_env() -> Self {
        match env::var(TRANSPORT_ENABLE_ENV) {
            Ok(value) if value == "1" || value.eq_ignore_ascii_case("true") => Self::Enabled,
            _ => Self::Disabled,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsResponse {
    #[serde(default)]
    choices: Vec<ChatCompletionChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChoice {
    message: ChatCompletionMessage,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ChatCompletionToolCall>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionToolCall {
    id: String,
    function: ChatCompletionFunction,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionFunction {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorEnvelope {
    error: Option<OpenAiErrorBody>,
}

#[derive(Debug, Deserialize)]
struct OpenAiErrorBody {
    message: Option<String>,
    #[serde(rename = "type")]
    error_type: Option<String>,
    code: Option<String>,
}

impl OpenAiChatCompletionsProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, ProviderError> {
        Ok(Self {
            config: validate_model(config, ProviderProtocol::OpenAiChatCompletions)?,
        })
    }

    pub fn build_protocol_request(
        &self,
        request: &ProviderRequest,
    ) -> OpenAiChatCompletionsRequest {
        let mut messages = request
            .session
            .messages
            .iter()
            .map(|message| {
                if message.role == "assistant" {
                    json!({ "role": "assistant", "content": message.content })
                } else {
                    json!({
                        "role": if message.role == "system" { "system" } else { "user" },
                        "content": message.content,
                    })
                }
            })
            .collect::<Vec<_>>();

        messages.extend(request.tool_results.iter().map(|result| {
            json!({
                "role": "tool",
                "tool_call_id": result.call_id,
                "content": tool_result_payload(result),
            })
        }));

        OpenAiChatCompletionsRequest {
            model: self.config.model.clone(),
            messages,
            tools: Vec::new(),
            tool_choice: "auto".to_string(),
        }
    }

    pub fn build_http_request_config(
        &self,
        api_key: &str,
    ) -> Result<HttpRequestConfig, ProviderError> {
        let _ = api_key;
        Ok(HttpRequestConfig {
            url: self.chat_completions_url()?,
            headers: vec![
                ("authorization".to_string(), "[redacted]".to_string()),
                ("content-type".to_string(), "application/json".to_string()),
            ],
        })
    }

    async fn send_chat_completions(
        &self,
        request: ProviderRequest,
        api_key: &str,
        mode: HttpTransportMode,
    ) -> Result<ProviderResponse, ProviderError> {
        if mode == HttpTransportMode::Disabled {
            return Err(ProviderError::new(
                ProviderProtocol::OpenAiChatCompletions,
                ProviderProtocol::OpenAiChatCompletions,
                0,
                Some("provider_transport_disabled"),
                Option::<String>::None,
                format!(
                    "HTTP transport is disabled. Set {TRANSPORT_ENABLE_ENV}=1 and configure {GATEWAY_API_KEY_ENV} or {OPENAI_API_KEY_ENV} in the process environment."
                ),
            ));
        }

        if api_key.trim().is_empty() {
            return Err(ProviderError::new(
                ProviderProtocol::OpenAiChatCompletions,
                ProviderProtocol::OpenAiChatCompletions,
                0,
                Some("provider_auth_missing"),
                Option::<String>::None,
                format!(
                    "Missing API key. Configure {GATEWAY_API_KEY_ENV} or {OPENAI_API_KEY_ENV} in the process environment."
                ),
            ));
        }

        let url = self.chat_completions_url()?;
        let body = self.build_protocol_request(&request);
        let response = reqwest::Client::new()
            .post(url)
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                ProviderError::transport(
                    ProviderProtocol::OpenAiChatCompletions,
                    format!("Chat Completions request failed: {error}"),
                )
            })?;

        let status = response.status();
        let body = response.text().await.map_err(|error| {
            ProviderError::transport(
                ProviderProtocol::OpenAiChatCompletions,
                format!("Chat Completions response read failed: {error}"),
            )
        })?;

        if !status.is_success() {
            return Err(provider_api_error(status.as_u16(), &body));
        }

        parse_chat_completions_response(&body)
    }

    fn chat_completions_url(&self) -> Result<String, ProviderError> {
        let base_url = self
            .config
            .base_url
            .as_deref()
            .unwrap_or(DEFAULT_OPENAI_BASE_URL)
            .trim_end_matches('/');
        let url = if base_url.ends_with("/chat/completions") {
            base_url.to_string()
        } else {
            format!("{base_url}/chat/completions")
        };

        reqwest::Url::parse(&url).map_err(|error| {
            ProviderError::new(
                ProviderProtocol::OpenAiChatCompletions,
                ProviderProtocol::OpenAiChatCompletions,
                0,
                Some("invalid_provider_config"),
                Option::<String>::None,
                format!("Invalid Chat Completions base URL: {error}"),
            )
        })?;

        Ok(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProviderKind, SessionState};
    use std::path::PathBuf;

    fn provider() -> OpenAiChatCompletionsProvider {
        OpenAiChatCompletionsProvider::new(ProviderConfig {
            kind: ProviderKind::OpenAiChatCompletions,
            model: "gpt-rs".to_string(),
            base_url: Some("https://gateway.invalid/v1/".to_string()),
        })
        .unwrap()
    }

    fn request() -> ProviderRequest {
        ProviderRequest {
            session: SessionState {
                id: "session-rs".to_string(),
                cwd: PathBuf::from("."),
                permission_mode: crate::PermissionMode::Safe,
                messages: vec![crate::user_message("Hello")],
            },
            tool_results: Vec::new(),
        }
    }

    #[test]
    fn http_request_config_redacts_authorization_header() {
        let config = provider()
            .build_http_request_config("abcdefghijklmnopqrstuvwxyz123456")
            .unwrap();

        assert_eq!(
            config.url,
            "https://gateway.invalid/v1/chat/completions".to_string()
        );
        assert_eq!(
            config.headers,
            vec![
                ("authorization".to_string(), "[redacted]".to_string()),
                ("content-type".to_string(), "application/json".to_string())
            ]
        );
    }

    #[tokio::test]
    async fn gated_transport_error_does_not_include_env_secret() {
        let error = provider()
            .send_chat_completions(
                request(),
                "abcdefghijklmnopqrstuvwxyz123456",
                HttpTransportMode::Disabled,
            )
            .await
            .unwrap_err();
        let rendered = error.to_string();

        assert!(rendered.contains("provider_transport_disabled"));
        assert!(!rendered.contains("abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[test]
    fn api_error_body_does_not_include_secret_material() {
        let error = provider_api_error(
            401,
            r#"{"error":{"message":"bad key token=abcdefghijklmnopqrstuvwxyz123456.","type":"invalid_request_error","code":"invalid_api_key"}}"#,
        );
        let rendered = error.to_string();

        assert!(rendered.contains("HTTP 401 invalid_api_key"));
        assert!(rendered.contains("token=[redacted]"));
        assert!(!rendered.contains("abcdefghijklmnopqrstuvwxyz123456"));
    }
}

#[async_trait]
impl ModelProvider for OpenAiChatCompletionsProvider {
    fn protocol(&self) -> Option<ProviderProtocol> {
        Some(ProviderProtocol::OpenAiChatCompletions)
    }

    async fn create_turn(&self, request: ProviderRequest) -> anyhow::Result<ProviderResponse> {
        let api_key = env::var(GATEWAY_API_KEY_ENV)
            .or_else(|_| env::var(OPENAI_API_KEY_ENV))
            .unwrap_or_default();
        Ok(self
            .send_chat_completions(request, &api_key, HttpTransportMode::from_env())
            .await?)
    }
}

fn parse_chat_completions_response(body: &str) -> Result<ProviderResponse, ProviderError> {
    let response = serde_json::from_str::<ChatCompletionsResponse>(body).map_err(|error| {
        ProviderError::new(
            ProviderProtocol::OpenAiChatCompletions,
            ProviderProtocol::OpenAiChatCompletions,
            0,
            Some("provider_response_parse_error"),
            Option::<String>::None,
            format!("Chat Completions response JSON parse failed: {error}"),
        )
    })?;

    let Some(choice) = response.choices.into_iter().next() else {
        return Ok(ProviderResponse {
            assistant_message: None,
            tool_calls: Vec::new(),
        });
    };

    let tool_calls = choice
        .message
        .tool_calls
        .into_iter()
        .map(|call| crate::ToolCall {
            id: call.id,
            name: call.function.name,
            input: serde_json::from_str(&call.function.arguments)
                .unwrap_or_else(|_| json!({ "arguments": call.function.arguments })),
        })
        .collect();

    Ok(ProviderResponse {
        assistant_message: choice.message.content,
        tool_calls,
    })
}

fn provider_api_error(status: u16, body: &str) -> ProviderError {
    if let Ok(envelope) = serde_json::from_str::<OpenAiErrorEnvelope>(body) {
        if let Some(error) = envelope.error {
            return ProviderError::new(
                ProviderProtocol::OpenAiChatCompletions,
                ProviderProtocol::OpenAiChatCompletions,
                status,
                error.error_type,
                error.code,
                error
                    .message
                    .unwrap_or_else(|| "Chat Completions API request failed".to_string()),
            );
        }
    }

    ProviderError::new(
        ProviderProtocol::OpenAiChatCompletions,
        ProviderProtocol::OpenAiChatCompletions,
        status,
        Some("provider_api_error"),
        Option::<String>::None,
        if body.trim().is_empty() {
            "Chat Completions API request failed".to_string()
        } else {
            body.to_string()
        },
    )
}
