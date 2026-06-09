use super::{tool_result_payload, validate_model};
use crate::{
    ModelProvider, ProviderConfig, ProviderError, ProviderProtocol, ProviderRequest,
    ProviderResponse,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct AnthropicMessagesProvider {
    config: ProviderConfig,
    max_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnthropicMessagesRequest {
    pub model: String,
    pub max_tokens: u32,
    pub system: Option<String>,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
}

impl AnthropicMessagesProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, ProviderError> {
        Ok(Self {
            config: validate_model(config, ProviderProtocol::AnthropicMessages)?,
            max_tokens: 4096,
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
}

#[async_trait]
impl ModelProvider for AnthropicMessagesProvider {
    fn protocol(&self) -> Option<ProviderProtocol> {
        Some(ProviderProtocol::AnthropicMessages)
    }

    async fn create_turn(&self, _request: ProviderRequest) -> anyhow::Result<ProviderResponse> {
        Err(ProviderError::not_implemented(ProviderProtocol::AnthropicMessages).into())
    }
}
