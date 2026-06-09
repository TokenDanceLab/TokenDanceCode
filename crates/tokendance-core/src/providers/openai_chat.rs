use super::{tool_result_payload, validate_model};
use crate::{
    ModelProvider, ProviderConfig, ProviderError, ProviderProtocol, ProviderRequest,
    ProviderResponse,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
}

#[async_trait]
impl ModelProvider for OpenAiChatCompletionsProvider {
    fn protocol(&self) -> Option<ProviderProtocol> {
        Some(ProviderProtocol::OpenAiChatCompletions)
    }

    async fn create_turn(&self, _request: ProviderRequest) -> anyhow::Result<ProviderResponse> {
        Err(ProviderError::not_implemented(ProviderProtocol::OpenAiChatCompletions).into())
    }
}
