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

/// Check whether HTTP transport is enabled via the given environment variable.
/// Returns `Ok(())` when enabled, or a `ProviderError` with a clear message.
pub(crate) fn check_http_transport(
    env_var: &str,
    protocol: ProviderProtocol,
) -> Result<(), ProviderError> {
    if std::env::var(env_var).unwrap_or_default() == "1" {
        Ok(())
    } else {
        Err(ProviderError::new(
            protocol,
            protocol,
            0,
            Some("provider_transport_disabled"),
            Option::<String>::None,
            format!(
                "HTTP transport is disabled. Set {env_var}=1 to enable.",
                env_var = env_var
            ),
        ))
    }
}

/// Resolve an API key from the primary env var, falling back to the secondary.
pub(crate) fn resolve_api_key(
    primary: &str,
    fallback: &str,
    protocol: ProviderProtocol,
) -> Result<String, ProviderError> {
    std::env::var(primary)
        .or_else(|_| std::env::var(fallback))
        .map_err(|_| {
            ProviderError::new(
                protocol,
                protocol,
                0,
                Some("provider_auth_missing"),
                Option::<String>::None,
                format!(
                    "Missing API key. Configure {primary} or {fallback} in the process environment."
                ),
            )
        })
}

/// Build a `reqwest::Client` with common configuration shared across providers.
pub(crate) fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("failed to build reqwest client")
}
