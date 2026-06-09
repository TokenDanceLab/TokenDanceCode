use super::{
    build_http_client, check_http_transport, resolve_api_key, tool_result_payload, validate_model,
};
use crate::{
    ModelProvider, ProviderConfig, ProviderError, ProviderProtocol, ProviderRequest,
    ProviderResponse,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
const TRANSPORT_ENABLE_ENV: &str = "TOKENDANCE_ANTHROPIC_TRANSPORT";
const PRIMARY_API_KEY_ENV: &str = "TOKENDANCE_ANTHROPIC_API_KEY";
const FALLBACK_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone)]
pub struct AnthropicMessagesProvider {
    config: ProviderConfig,
    max_tokens: u32,
    client: reqwest::Client,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnthropicMessagesRequest {
    pub model: String,
    pub max_tokens: u32,
    pub system: Option<String>,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
}

#[derive(Debug, Deserialize)]
struct AnthropicMessagesResponse {
    #[serde(default)]
    content: Vec<AnthropicContentBlock>,
    #[serde(default)]
    #[allow(dead_code)]
    stop_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AnthropicContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    // Catch-all for unknown content block types (e.g. thinking)
    #[serde(other)]
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Deserialize)]
struct AnthropicErrorEnvelope {
    error: Option<AnthropicErrorBody>,
}

#[derive(Debug, Deserialize)]
struct AnthropicErrorBody {
    #[serde(rename = "type")]
    error_type: Option<String>,
    message: Option<String>,
}

impl AnthropicMessagesProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, ProviderError> {
        Ok(Self {
            config: validate_model(config, ProviderProtocol::AnthropicMessages)?,
            max_tokens: 4096,
            client: build_http_client(),
        })
    }

    pub fn build_protocol_request(&self, request: &ProviderRequest) -> AnthropicMessagesRequest {
        let system = request
            .session
            .messages
            .iter()
            .filter(|message| message.role == "system")
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        let mut messages = request
            .session
            .messages
            .iter()
            .filter(|message| message.role != "system")
            .map(|message| {
                json!({
                    "role": if message.role == "assistant" { "assistant" } else { "user" },
                    "content": message.content,
                })
            })
            .collect::<Vec<_>>();

        if !request.tool_results.is_empty() {
            messages.push(json!({
                "role": "user",
                "content": request.tool_results.iter().map(|result| {
                    json!({
                        "type": "tool_result",
                        "tool_use_id": result.call_id,
                        "content": tool_result_payload(result),
                        "is_error": if result.ok { Value::Null } else { Value::Bool(true) },
                    })
                }).collect::<Vec<_>>(),
            }));
        }

        AnthropicMessagesRequest {
            model: self.config.model.clone(),
            max_tokens: self.max_tokens,
            system: if system.is_empty() {
                None
            } else {
                Some(system)
            },
            messages,
            tools: Vec::new(),
        }
    }

    fn messages_url(&self) -> Result<String, ProviderError> {
        let base_url = self
            .config
            .base_url
            .as_deref()
            .unwrap_or(DEFAULT_ANTHROPIC_BASE_URL)
            .trim_end_matches('/');
        let url = if base_url.ends_with("/v1/messages") {
            base_url.to_string()
        } else if base_url.ends_with("/v1") {
            format!("{base_url}/messages")
        } else {
            format!("{base_url}/v1/messages")
        };

        reqwest::Url::parse(&url).map_err(|error| {
            ProviderError::new(
                ProviderProtocol::AnthropicMessages,
                ProviderProtocol::AnthropicMessages,
                0,
                Some("invalid_provider_config"),
                Option::<String>::None,
                format!("Invalid Anthropic base URL: {error}"),
            )
        })?;

        Ok(url)
    }

    async fn send_messages(
        &self,
        request: ProviderRequest,
    ) -> Result<ProviderResponse, ProviderError> {
        check_http_transport(TRANSPORT_ENABLE_ENV, ProviderProtocol::AnthropicMessages)?;

        let api_key = resolve_api_key(
            PRIMARY_API_KEY_ENV,
            FALLBACK_API_KEY_ENV,
            ProviderProtocol::AnthropicMessages,
        )?;

        let url = self.messages_url()?;
        let body = self.build_protocol_request(&request);
        let response = self
            .client
            .post(&url)
            .header("x-api-key", &api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                ProviderError::transport(
                    ProviderProtocol::AnthropicMessages,
                    format!("Anthropic Messages request failed: {error}"),
                )
            })?;

        let status = response.status();
        let response_body = response.text().await.map_err(|error| {
            ProviderError::transport(
                ProviderProtocol::AnthropicMessages,
                format!("Anthropic Messages response read failed: {error}"),
            )
        })?;

        if !status.is_success() {
            return Err(provider_api_error(status.as_u16(), &response_body));
        }

        parse_messages_response(&response_body)
    }
}

#[async_trait]
impl ModelProvider for AnthropicMessagesProvider {
    fn protocol(&self) -> Option<ProviderProtocol> {
        Some(ProviderProtocol::AnthropicMessages)
    }

    async fn create_turn(&self, request: ProviderRequest) -> anyhow::Result<ProviderResponse> {
        Ok(self.send_messages(request).await?)
    }
}

fn parse_messages_response(body: &str) -> Result<ProviderResponse, ProviderError> {
    let response = serde_json::from_str::<AnthropicMessagesResponse>(body).map_err(|error| {
        ProviderError::new(
            ProviderProtocol::AnthropicMessages,
            ProviderProtocol::AnthropicMessages,
            0,
            Some("provider_response_parse_error"),
            Option::<String>::None,
            format!("Anthropic Messages response JSON parse failed: {error}"),
        )
    })?;

    let mut assistant_message: Option<String> = None;
    let mut tool_calls = Vec::new();

    for block in response.content {
        match block {
            AnthropicContentBlock::Text { text } => {
                if let Some(ref mut existing) = assistant_message {
                    existing.push_str(&text);
                } else {
                    assistant_message = Some(text);
                }
            }
            AnthropicContentBlock::ToolUse { id, name, input } => {
                tool_calls.push(crate::ToolCall { id, name, input });
            }
            AnthropicContentBlock::Other => {}
        }
    }

    Ok(ProviderResponse {
        assistant_message,
        tool_calls,
    })
}

fn provider_api_error(status: u16, body: &str) -> ProviderError {
    if let Ok(envelope) = serde_json::from_str::<AnthropicErrorEnvelope>(body)
        && let Some(error) = envelope.error
    {
        return ProviderError::new(
            ProviderProtocol::AnthropicMessages,
            ProviderProtocol::AnthropicMessages,
            status,
            error.error_type,
            Option::<String>::None,
            error
                .message
                .unwrap_or_else(|| "Anthropic API request failed".to_string()),
        );
    }

    ProviderError::new(
        ProviderProtocol::AnthropicMessages,
        ProviderProtocol::AnthropicMessages,
        status,
        Some("provider_api_error"),
        Option::<String>::None,
        if body.trim().is_empty() {
            "Anthropic API request failed".to_string()
        } else {
            body.to_string()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProviderKind, SessionState};
    use std::path::PathBuf;

    fn provider() -> AnthropicMessagesProvider {
        AnthropicMessagesProvider::new(ProviderConfig {
            kind: ProviderKind::AnthropicMessages,
            model: "claude-rs".to_string(),
            base_url: Some("https://anthropic.invalid".to_string()),
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
    fn messages_url_builds_correctly() {
        let p = provider();
        assert_eq!(
            p.messages_url().unwrap(),
            "https://anthropic.invalid/v1/messages"
        );
    }

    #[test]
    fn messages_url_handles_trailing_slash_and_v1_suffix() {
        let p = AnthropicMessagesProvider::new(ProviderConfig {
            kind: ProviderKind::AnthropicMessages,
            model: "claude-rs".to_string(),
            base_url: Some("https://anthropic.invalid/v1/".to_string()),
        })
        .unwrap();
        assert_eq!(
            p.messages_url().unwrap(),
            "https://anthropic.invalid/v1/messages"
        );
    }

    #[test]
    fn http_transport_gated_when_env_not_set() {
        // By default the env var is not set in test processes
        let result =
            check_http_transport(TRANSPORT_ENABLE_ENV, ProviderProtocol::AnthropicMessages);
        assert!(result.is_err());
        let err = result.unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("provider_transport_disabled"));
        assert!(rendered.contains(TRANSPORT_ENABLE_ENV));
    }

    #[test]
    fn api_key_resolves_from_primary() {
        // Neither env var should be set in test processes
        let result = resolve_api_key(
            PRIMARY_API_KEY_ENV,
            FALLBACK_API_KEY_ENV,
            ProviderProtocol::AnthropicMessages,
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("provider_auth_missing"));
        assert!(rendered.contains(PRIMARY_API_KEY_ENV));
        assert!(rendered.contains(FALLBACK_API_KEY_ENV));
    }

    #[test]
    fn error_body_redacts_secret_material() {
        let error = provider_api_error(
            401,
            r#"{"error":{"type":"authentication_error","message":"invalid x-api-key sk-abcdefghijklmnopqrstuvwxyz123456"}}"#,
        );
        let rendered = error.to_string();

        assert!(rendered.contains("HTTP 401 authentication_error"));
        // The long alphanumeric token starting with sk- is redacted by redact_secret_like
        assert!(!rendered.contains("abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[test]
    fn protocol_request_serializes_correctly() {
        let p = provider();
        let req = p.build_protocol_request(&request());
        let json_val = serde_json::to_value(&req).unwrap();

        assert_eq!(json_val["model"], "claude-rs");
        assert_eq!(json_val["max_tokens"], 4096);
        assert!(json_val["messages"].is_array());
    }

    #[test]
    fn parse_messages_extracts_text_and_tool_use() {
        let body = r#"{
            "content": [
                {"type": "text", "text": "I will read that file."},
                {"type": "tool_use", "id": "toolu_abc123", "name": "read_file", "input": {"path": "/tmp/test"}}
            ],
            "stop_reason": "tool_use",
            "model": "claude-rs"
        }"#;

        let result = parse_messages_response(body).unwrap();
        assert_eq!(
            result.assistant_message,
            Some("I will read that file.".to_string())
        );
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].id, "toolu_abc123");
        assert_eq!(result.tool_calls[0].name, "read_file");
        assert_eq!(result.tool_calls[0].input["path"], "/tmp/test");
    }

    #[test]
    fn parse_messages_end_turn_without_tools() {
        let body = r#"{
            "content": [
                {"type": "text", "text": "Done!"}
            ],
            "stop_reason": "end_turn",
            "model": "claude-rs"
        }"#;

        let result = parse_messages_response(body).unwrap();
        assert_eq!(result.assistant_message, Some("Done!".to_string()));
        assert!(result.tool_calls.is_empty());
    }
}
