mod anthropic;
mod openai_chat;
mod openai_responses;

pub use anthropic::{AnthropicMessagesProvider, AnthropicMessagesRequest};
pub use openai_chat::{OpenAiChatCompletionsProvider, OpenAiChatCompletionsRequest};
pub use openai_responses::{OpenAiResponsesProvider, OpenAiResponsesRequest};

use crate::{ProviderConfig, ProviderError, ProviderProtocol, ToolResult};
use serde_json::{Value, json};

fn validate_model(
    config: ProviderConfig,
    protocol: ProviderProtocol,
) -> Result<ProviderConfig, ProviderError> {
    if config.model.trim().is_empty() {
        return Err(ProviderError::new(
            protocol,
            protocol,
            0,
            Some("invalid_provider_config"),
            Option::<String>::None,
            "Provider model must not be empty",
        ));
    }
    Ok(config)
}

fn tool_result_payload(result: &ToolResult) -> String {
    let value = if result.ok {
        result.output.clone().unwrap_or(Value::Null)
    } else {
        json!({ "error": result.error.as_deref().unwrap_or("Tool failed") })
    };
    serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string())
}
