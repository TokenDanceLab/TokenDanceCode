use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Mock,
    OpenAiResponses,
    OpenAiChatCompletions,
    AnthropicMessages,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub model: String,
    pub base_url: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            kind: ProviderKind::Mock,
            model: "mock".to_string(),
            base_url: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorInfo {
    pub version: String,
    pub rust_runtime: bool,
    pub provider: ProviderConfig,
    pub warnings: Vec<String>,
}

pub fn doctor_info(version: impl Into<String>, provider: ProviderConfig) -> DoctorInfo {
    DoctorInfo {
        version: version.into(),
        rust_runtime: true,
        provider,
        warnings: Vec::new(),
    }
}
