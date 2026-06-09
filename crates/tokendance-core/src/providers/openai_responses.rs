use super::{tool_result_payload, validate_model};
use crate::{
    ModelProvider, ProviderConfig, ProviderError, ProviderProtocol, ProviderRequest,
    ProviderResponse,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct OpenAiResponsesProvider {
    config: ProviderConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAiResponsesRequest {
    pub model: String,
    pub input: Vec<Value>,
    pub tools: Vec<Value>,
    pub tool_choice: String,
    pub parallel_tool_calls: bool,
}

impl OpenAiResponsesProvider {
    pub fn new(config: ProviderConfig) -> Result<Self, ProviderError> {
        Ok(Self {
            config: validate_model(config, ProviderProtocol::OpenAiResponses)?,
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
}

#[async_trait]
impl ModelProvider for OpenAiResponsesProvider {
    fn protocol(&self) -> Option<ProviderProtocol> {
        Some(ProviderProtocol::OpenAiResponses)
    }

    async fn create_turn(&self, _request: ProviderRequest) -> anyhow::Result<ProviderResponse> {
        Err(ProviderError::not_implemented(ProviderProtocol::OpenAiResponses).into())
    }
}
