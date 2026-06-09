use crate::{Message, SessionState, ToolCall, ToolResult};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

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

#[async_trait]
pub trait ModelProvider: Send + Sync {
    async fn create_turn(&self, request: ProviderRequest) -> anyhow::Result<ProviderResponse>;
}

#[derive(Debug, Default)]
pub struct MockProvider;

#[async_trait]
impl ModelProvider for MockProvider {
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
