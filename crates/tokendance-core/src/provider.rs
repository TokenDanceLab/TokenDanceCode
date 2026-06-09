use crate::{Message, ProviderConfig, ProviderKind, SessionState, ToolCall, ToolResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRequest {
    pub session: SessionState,
    pub tool_results: Vec<ToolResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderResponse {
    pub assistant_message: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderProtocol {
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "openai-chat-completions")]
    OpenAiChatCompletions,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
}

impl std::fmt::Display for ProviderProtocol {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::OpenAiResponses => "openai-responses",
            Self::OpenAiChatCompletions => "openai-chat-completions",
            Self::AnthropicMessages => "anthropic-messages",
        };
        formatter.write_str(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("[{provider}] HTTP {status}{classifier}: {message}")]
pub struct ProviderError {
    pub provider: ProviderProtocol,
    pub protocol: ProviderProtocol,
    pub status: u16,
    pub error_type: Option<String>,
    pub code: Option<String>,
    classifier: String,
    message: String,
}

impl ProviderError {
    pub fn new(
        provider: ProviderProtocol,
        protocol: ProviderProtocol,
        status: u16,
        error_type: Option<impl Into<String>>,
        code: Option<impl Into<String>>,
        message: impl AsRef<str>,
    ) -> Self {
        let error_type = error_type.map(Into::into);
        let code = code.map(Into::into);
        let classifier = code
            .as_ref()
            .or(error_type.as_ref())
            .map(|value| format!(" {value}"))
            .unwrap_or_default();

        Self {
            provider,
            protocol,
            status,
            error_type,
            code,
            classifier,
            message: redact_secret_like(message.as_ref()),
        }
    }

    pub fn transport(provider: ProviderProtocol, message: impl AsRef<str>) -> Self {
        Self::new(
            provider,
            provider,
            0,
            Some("provider_transport_error"),
            Option::<String>::None,
            message,
        )
    }

    pub fn not_implemented(provider: ProviderProtocol) -> Self {
        Self::new(
            provider,
            provider,
            0,
            Some("provider_not_implemented"),
            Option::<String>::None,
            "Provider HTTP transport is not implemented in the Rust scaffold yet",
        )
    }
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn protocol(&self) -> Option<ProviderProtocol>;

    async fn create_turn(&self, request: ProviderRequest) -> anyhow::Result<ProviderResponse>;
}

#[derive(Debug, Default)]
pub struct MockProvider;

#[async_trait]
impl ModelProvider for MockProvider {
    fn protocol(&self) -> Option<ProviderProtocol> {
        None
    }

    async fn create_turn(&self, request: ProviderRequest) -> anyhow::Result<ProviderResponse> {
        let prompt = request
            .session
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(|message| message.content.as_str())
            .unwrap_or("");
        Ok(ProviderResponse {
            assistant_message: Some(format!("mock response: {prompt}")),
            tool_calls: Vec::new(),
        })
    }
}

pub fn create_provider(config: ProviderConfig) -> Result<Box<dyn ModelProvider>, ProviderError> {
    match config.kind {
        ProviderKind::Mock => Ok(Box::new(MockProvider)),
        ProviderKind::OpenAiResponses => Ok(Box::new(
            crate::providers::OpenAiResponsesProvider::new(config)?,
        )),
        ProviderKind::OpenAiChatCompletions => Ok(Box::new(
            crate::providers::OpenAiChatCompletionsProvider::new(config)?,
        )),
        ProviderKind::AnthropicMessages => Ok(Box::new(
            crate::providers::AnthropicMessagesProvider::new(config)?,
        )),
    }
}

pub fn user_message(content: impl Into<String>) -> Message {
    Message {
        role: "user".to_string(),
        content: content.into(),
    }
}

pub fn assistant_message(content: impl Into<String>) -> Message {
    Message {
        role: "assistant".to_string(),
        content: content.into(),
    }
}

fn redact_secret_like(message: &str) -> String {
    message
        .split_whitespace()
        .map(|part| {
            if part.starts_with("sk-")
                || part.starts_with("td-")
                || part.starts_with("Bearer ")
                || part.len() >= 32 && part.chars().all(|ch| ch.is_ascii_alphanumeric())
            {
                "[redacted]"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PermissionMode, ProviderConfig, ProviderKind};
    use serde_json::json;
    use std::path::PathBuf;

    fn request() -> ProviderRequest {
        ProviderRequest {
            session: SessionState {
                id: "session-rs".to_string(),
                cwd: PathBuf::from("."),
                permission_mode: PermissionMode::Safe,
                messages: vec![
                    Message {
                        role: "system".to_string(),
                        content: "Follow project instructions.".to_string(),
                    },
                    user_message("Read the file"),
                    assistant_message("I will call a tool."),
                ],
            },
            tool_results: vec![ToolResult {
                call_id: "call-read".to_string(),
                tool_name: "read_file".to_string(),
                ok: true,
                output: Some(json!({ "content": "hello" })),
                error: None,
            }],
        }
    }

    #[test]
    fn provider_protocol_serializes_ts_contract_names() {
        assert_eq!(
            serde_json::to_value(ProviderProtocol::OpenAiResponses).unwrap(),
            json!("openai-responses")
        );
        assert_eq!(
            serde_json::to_value(ProviderProtocol::OpenAiChatCompletions).unwrap(),
            json!("openai-chat-completions")
        );
        assert_eq!(
            serde_json::to_value(ProviderProtocol::AnthropicMessages).unwrap(),
            json!("anthropic-messages")
        );
    }

    #[test]
    fn provider_error_format_does_not_include_secret_context() {
        let error = ProviderError::transport(
            ProviderProtocol::OpenAiChatCompletions,
            "request failed while using abcdefghijklmnopqrstuvwxyz123456",
        );

        let rendered = error.to_string();
        assert!(rendered.contains("[openai-chat-completions] HTTP 0 provider_transport_error"));
        assert!(!rendered.contains("abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[tokio::test]
    async fn factory_keeps_mock_provider_working() {
        let provider = create_provider(ProviderConfig::default()).unwrap();
        assert_eq!(provider.protocol(), None);

        let response = provider.create_turn(request()).await.unwrap();
        assert_eq!(
            response.assistant_message,
            Some("mock response: Read the file".to_string())
        );
        assert!(response.tool_calls.is_empty());
    }

    #[test]
    fn factory_dispatches_configured_protocols_without_secret_material() {
        let cases = [
            (
                ProviderKind::OpenAiResponses,
                ProviderProtocol::OpenAiResponses,
            ),
            (
                ProviderKind::OpenAiChatCompletions,
                ProviderProtocol::OpenAiChatCompletions,
            ),
            (
                ProviderKind::AnthropicMessages,
                ProviderProtocol::AnthropicMessages,
            ),
        ];

        for (kind, protocol) in cases {
            let provider = create_provider(ProviderConfig {
                kind,
                model: "model-rs".to_string(),
                base_url: Some("https://example.invalid/v1".to_string()),
            })
            .unwrap();
            assert_eq!(provider.protocol(), Some(protocol));
        }
    }

    #[test]
    fn openai_responses_mapping_uses_responses_input_and_tool_outputs() {
        let provider = crate::providers::OpenAiResponsesProvider::new(ProviderConfig {
            kind: ProviderKind::OpenAiResponses,
            model: "gpt-rs".to_string(),
            base_url: Some("https://gateway.invalid/v1".to_string()),
        })
        .unwrap();

        let mapped = provider.build_protocol_request(&request());
        assert_eq!(mapped.model, "gpt-rs");
        assert_eq!(mapped.input[0]["role"], "system");
        assert_eq!(mapped.input[1]["role"], "user");
        assert_eq!(mapped.input[3]["type"], "function_call_output");
        assert_eq!(mapped.input[3]["call_id"], "call-read");
        assert_eq!(mapped.tool_choice, "auto");
        assert!(mapped.parallel_tool_calls);
    }

    #[test]
    fn openai_chat_mapping_uses_chat_messages_and_tool_role_results() {
        let provider = crate::providers::OpenAiChatCompletionsProvider::new(ProviderConfig {
            kind: ProviderKind::OpenAiChatCompletions,
            model: "deepseek-rs".to_string(),
            base_url: Some("https://api.vectorcontrol.tech/v1".to_string()),
        })
        .unwrap();

        let mapped = provider.build_protocol_request(&request());
        assert_eq!(mapped.model, "deepseek-rs");
        assert_eq!(mapped.messages[0]["role"], "system");
        assert_eq!(mapped.messages[1]["role"], "user");
        assert_eq!(mapped.messages[3]["role"], "tool");
        assert_eq!(mapped.messages[3]["tool_call_id"], "call-read");
        assert_eq!(mapped.tool_choice, "auto");
    }

    #[test]
    fn anthropic_mapping_splits_system_and_user_tool_result_blocks() {
        let provider = crate::providers::AnthropicMessagesProvider::new(ProviderConfig {
            kind: ProviderKind::AnthropicMessages,
            model: "claude-rs".to_string(),
            base_url: Some("https://anthropic.invalid".to_string()),
        })
        .unwrap();

        let mapped = provider.build_protocol_request(&request());
        assert_eq!(mapped.model, "claude-rs");
        assert_eq!(
            mapped.system,
            Some("Follow project instructions.".to_string())
        );
        assert_eq!(mapped.messages[0]["role"], "user");
        assert_eq!(mapped.messages[2]["role"], "user");
        assert_eq!(mapped.messages[2]["content"][0]["type"], "tool_result");
        assert_eq!(mapped.messages[2]["content"][0]["tool_use_id"], "call-read");
        assert_eq!(mapped.max_tokens, 4096);
    }
}
