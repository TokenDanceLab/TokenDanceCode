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

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const TRANSPORT_ENABLE_ENV: &str = "TOKENDANCE_OPENAI_TRANSPORT";
const PRIMARY_API_KEY_ENV: &str = "TOKENDANCE_OPENAI_API_KEY";
const FALLBACK_API_KEY_ENV: &str = "OPENAI_API_KEY";

#[derive(Debug, Clone)]
pub struct OpenAiResponsesProvider {
    config: ProviderConfig,
    client: reqwest::Client,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiResponsesRequest {
    pub model: String,
    pub input: Vec<Value>,
    pub tools: Vec<Value>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
}

#[derive(Debug, Deserialize)]
struct ResponsesApiOutput {
    #[serde(default)]
    output: Vec<ResponsesOutputItem>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ResponsesOutputItem {
    #[serde(rename = "message")]
    Message {
        #[serde(default)]
        content: Vec<ResponsesContentPart>,
    },
    #[serde(rename = "function_call")]
    FunctionCall {
        #[serde(default)]
        call_id: String,
        name: String,
        arguments: String,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        code: Option<String>,
    },
    // Catch-all for unknown output item types (e.g. reasoning, etc.)
    #[serde(other)]
    #[serde(rename = "other")]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ResponsesContentPart {
    #[serde(rename = "output_text")]
    OutputText { text: String },
    // Catch-all for unknown content types
    #[serde(other)]
    #[serde(rename = "other")]
    Other,
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

impl OpenAiResponsesProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, ProviderError> {
        Ok(Self {
            config: validate_model(config, ProviderProtocol::OpenAiResponses)?,
            client: build_http_client(),
        })
    }

    pub fn build_protocol_request(&self, request: &ProviderRequest) -> OpenAiResponsesRequest {
        let mut input = request
            .session
            .messages
            .iter()
            .map(|message| {
                json!({
                    "role": if message.role == "tool" { "user" } else { message.role.as_str() },
                    "content": message.content,
                })
            })
            .collect::<Vec<_>>();

        input.extend(request.tool_results.iter().map(|result| {
            json!({
                "type": "function_call_output",
                "call_id": result.call_id,
                "output": tool_result_payload(result),
            })
        }));

        OpenAiResponsesRequest {
            model: self.config.model.clone(),
            input,
            tools: Vec::new(),
            tool_choice: "auto".to_string(),
            parallel_tool_calls: true,
        }
    }

    fn responses_url(&self) -> Result<String, ProviderError> {
        let base_url = self
            .config
            .base_url
            .as_deref()
            .unwrap_or(DEFAULT_OPENAI_BASE_URL)
            .trim_end_matches('/');
        let url = if base_url.ends_with("/responses") {
            base_url.to_string()
        } else {
            // Strip /v1/chat/completions or similar suffixes to get the base
            let base = if let Some(idx) = base_url.find("/v1") {
                &base_url[..idx + 3]
            } else {
                base_url
            };
            format!("{}/responses", base.trim_end_matches('/'))
        };

        reqwest::Url::parse(&url).map_err(|error| {
            ProviderError::new(
                ProviderProtocol::OpenAiResponses,
                ProviderProtocol::OpenAiResponses,
                0,
                Some("invalid_provider_config"),
                Option::<String>::None,
                format!("Invalid Responses base URL: {error}"),
            )
        })?;

        Ok(url)
    }

    async fn send_responses(
        &self,
        request: ProviderRequest,
    ) -> Result<ProviderResponse, ProviderError> {
        check_http_transport(TRANSPORT_ENABLE_ENV, ProviderProtocol::OpenAiResponses)?;

        let api_key = resolve_api_key(
            PRIMARY_API_KEY_ENV,
            FALLBACK_API_KEY_ENV,
            ProviderProtocol::OpenAiResponses,
        )?;

        let url = self.responses_url()?;
        let body = self.build_protocol_request(&request);
        let response = self
            .client
            .post(&url)
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                ProviderError::transport(
                    ProviderProtocol::OpenAiResponses,
                    format!("Responses request failed: {error}"),
                )
            })?;

        let status = response.status();
        let response_body = response.text().await.map_err(|error| {
            ProviderError::transport(
                ProviderProtocol::OpenAiResponses,
                format!("Responses response read failed: {error}"),
            )
        })?;

        if !status.is_success() {
            return Err(provider_api_error(status.as_u16(), &response_body));
        }

        parse_responses_response(&response_body)
    }
}

#[async_trait]
impl ModelProvider for OpenAiResponsesProvider {
    fn protocol(&self) -> Option<ProviderProtocol> {
        Some(ProviderProtocol::OpenAiResponses)
    }

    async fn create_turn(&self, request: ProviderRequest) -> anyhow::Result<ProviderResponse> {
        Ok(self.send_responses(request).await?)
    }
}

fn parse_responses_response(body: &str) -> Result<ProviderResponse, ProviderError> {
    let response = serde_json::from_str::<ResponsesApiOutput>(body).map_err(|error| {
        ProviderError::new(
            ProviderProtocol::OpenAiResponses,
            ProviderProtocol::OpenAiResponses,
            0,
            Some("provider_response_parse_error"),
            Option::<String>::None,
            format!("Responses response JSON parse failed: {error}"),
        )
    })?;

    let mut assistant_message: Option<String> = None;
    let mut tool_calls = Vec::new();

    for item in response.output {
        match item {
            ResponsesOutputItem::Message { content } => {
                for part in content {
                    if let ResponsesContentPart::OutputText { text } = part {
                        if let Some(ref mut existing) = assistant_message {
                            existing.push_str(&text);
                        } else {
                            assistant_message = Some(text);
                        }
                    }
                }
            }
            ResponsesOutputItem::FunctionCall {
                call_id,
                name,
                arguments,
            } => {
                tool_calls.push(crate::ToolCall {
                    id: call_id,
                    name,
                    input: serde_json::from_str(&arguments)
                        .unwrap_or_else(|_| json!({ "arguments": arguments })),
                });
            }
            ResponsesOutputItem::Error { message, code } => {
                return Err(ProviderError::new(
                    ProviderProtocol::OpenAiResponses,
                    ProviderProtocol::OpenAiResponses,
                    0,
                    code,
                    Option::<String>::None,
                    message.unwrap_or_else(|| "Responses API returned an error".to_string()),
                ));
            }
            ResponsesOutputItem::Other => {}
        }
    }

    Ok(ProviderResponse {
        assistant_message,
        tool_calls,
    })
}

fn provider_api_error(status: u16, body: &str) -> ProviderError {
    if let Ok(envelope) = serde_json::from_str::<OpenAiErrorEnvelope>(body)
        && let Some(error) = envelope.error
    {
        return ProviderError::new(
            ProviderProtocol::OpenAiResponses,
            ProviderProtocol::OpenAiResponses,
            status,
            error.error_type,
            error.code,
            error
                .message
                .unwrap_or_else(|| "Responses API request failed".to_string()),
        );
    }

    ProviderError::new(
        ProviderProtocol::OpenAiResponses,
        ProviderProtocol::OpenAiResponses,
        status,
        Some("provider_api_error"),
        Option::<String>::None,
        if body.trim().is_empty() {
            "Responses API request failed".to_string()
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

    fn provider() -> OpenAiResponsesProvider {
        OpenAiResponsesProvider::new(ProviderConfig {
            kind: ProviderKind::OpenAiResponses,
            model: "gpt-rs".to_string(),
            base_url: Some("https://gateway.invalid/v1".to_string()),
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
    fn responses_url_builds_correctly() {
        let p = provider();
        assert_eq!(
            p.responses_url().unwrap(),
            "https://gateway.invalid/v1/responses"
        );
    }

    #[test]
    fn responses_url_handles_trailing_slash() {
        let p = OpenAiResponsesProvider::new(ProviderConfig {
            kind: ProviderKind::OpenAiResponses,
            model: "gpt-rs".to_string(),
            base_url: Some("https://gateway.invalid/v1/".to_string()),
        })
        .unwrap();
        assert_eq!(
            p.responses_url().unwrap(),
            "https://gateway.invalid/v1/responses"
        );
    }

    #[test]
    fn http_transport_gated_when_env_not_set() {
        // By default the env var is not set in test processes
        let result = check_http_transport(TRANSPORT_ENABLE_ENV, ProviderProtocol::OpenAiResponses);
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
            ProviderProtocol::OpenAiResponses,
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("provider_auth_missing"));
        assert!(rendered.contains(PRIMARY_API_KEY_ENV));
        assert!(rendered.contains(FALLBACK_API_KEY_ENV));
        // No secret material leaked
        assert!(!rendered.contains("sk-"));
    }

    #[test]
    fn error_body_redacts_secret_material() {
        let error = provider_api_error(
            401,
            r#"{"error":{"message":"bad key token=abcdefghijklmnopqrstuvwxyz123456.","type":"invalid_request_error","code":"invalid_api_key"}}"#,
        );
        let rendered = error.to_string();

        assert!(rendered.contains("HTTP 401 invalid_api_key"));
        assert!(rendered.contains("token=[redacted]"));
        assert!(!rendered.contains("abcdefghijklmnopqrstuvwxyz123456"));
    }

    #[test]
    fn protocol_request_serializes_correctly() {
        let p = provider();
        let req = p.build_protocol_request(&request());
        let json = serde_json::to_value(&req).unwrap();

        assert_eq!(json["model"], "gpt-rs");
        assert!(json["input"].is_array());
        assert_eq!(json["tool_choice"], "auto");
        assert_eq!(json["parallel_tool_calls"], true);
    }

    #[test]
    fn parse_responses_extracts_text_and_function_calls() {
        let body = r#"{
            "output": [
                {
                    "type": "message",
                    "content": [
                        {"type": "output_text", "text": "I will help you."}
                    ]
                },
                {
                    "type": "function_call",
                    "call_id": "call_abc123",
                    "name": "read_file",
                    "arguments": "{\"path\":\"/tmp/test\"}"
                }
            ]
        }"#;

        let result = parse_responses_response(body).unwrap();
        assert_eq!(
            result.assistant_message,
            Some("I will help you.".to_string())
        );
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].id, "call_abc123");
        assert_eq!(result.tool_calls[0].name, "read_file");
    }

    #[test]
    fn parse_responses_error_item_returns_provider_error() {
        let body = r#"{
            "output": [
                {
                    "type": "error",
                    "code": "rate_limit_exceeded",
                    "message": "Too many requests with sk-abcdefghijklmnopqrstuvwxyz123456"
                }
            ]
        }"#;

        let result = parse_responses_response(body);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("rate_limit_exceeded"));
        // The secret-like token should be redacted by ProviderError::new
        assert!(!err.contains("abcdefghijklmnopqrstuvwxyz123456"));
    }
}
