use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Default,
    Safe,
    Auto,
    Yolo,
}

impl Default for PermissionMode {
    fn default() -> Self {
        Self::Default
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolRisk {
    Read,
    Write,
    Shell,
    Network,
    Dangerous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionStatus {
    Allowed,
    RequiresApproval,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionDecision {
    pub status: PermissionStatus,
    pub reason: String,
    #[serde(rename = "riskMetadata", skip_serializing_if = "Option::is_none")]
    pub risk_metadata: Option<PermissionRiskMetadata>,
    pub mode: PermissionMode,
    pub tool_name: String,
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolConcurrency {
    Serial,
    ParallelSafe,
    Exclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecisionAction {
    Allowed,
    Denied,
    ApprovalRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRiskMetadata {
    pub mode: PermissionMode,
    pub tool_name: String,
    pub tool_risk: ToolRisk,
    pub action: PermissionDecisionAction,
    pub approval_scope: PermissionApprovalScope,
    pub concurrency: ToolConcurrency,
    pub safety_notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionApprovalScope {
    None,
    ToolCall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub input: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolResult {
    pub call_id: String,
    pub tool_name: String,
    pub ok: bool,
    pub output: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionState {
    pub id: String,
    pub cwd: PathBuf,
    pub permission_mode: PermissionMode,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum RuntimeEvent {
    #[serde(rename = "user.message")]
    TurnStarted {
        session_id: String,
        turn_id: String,
        prompt: String,
    },
    #[serde(rename = "assistant.completed")]
    ProviderCompleted {
        session_id: String,
        turn_id: String,
        assistant_message: Option<String>,
        tool_call_count: usize,
    },
    #[serde(rename = "tool.permission")]
    ToolPermission {
        session_id: String,
        turn_id: String,
        call: ToolCall,
        decision: PermissionDecision,
    },
    #[serde(rename = "turn.completed")]
    TurnCompleted {
        session_id: String,
        turn_id: String,
        final_response: String,
    },
    #[serde(rename = "turn.failed")]
    TurnFailed {
        session_id: String,
        turn_id: String,
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnResult {
    pub thread_id: String,
    pub turn_id: String,
    pub final_response: String,
    pub events: Vec<RuntimeEvent>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_events_serialize_ts_style_event_names() {
        let value = serde_json::to_value(RuntimeEvent::TurnCompleted {
            session_id: "session-rs".to_string(),
            turn_id: "turn-rs".to_string(),
            final_response: "done".to_string(),
        })
        .unwrap();

        assert_eq!(value["type"], "turn.completed");
    }
}
