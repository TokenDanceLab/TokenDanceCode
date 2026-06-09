use crate::{
    PermissionEngine, PermissionMode, PermissionProfileMetadata, PermissionRiskMetadata,
    PermissionStatus, SessionState, ToolCall, ToolConcurrency, ToolPolicy, ToolRisk,
    concurrency_label, permission_modes, risk_label,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

type ToolExecutor = Arc<dyn Fn(Value) -> anyhow::Result<Value> + Send + Sync>;

pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub risk: ToolRisk,
    pub concurrency: ToolConcurrency,
    pub safety_notes: Vec<String>,
    executor: ToolExecutor,
}

impl ToolDefinition {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        risk: ToolRisk,
        concurrency: ToolConcurrency,
        executor: impl Fn(Value) -> anyhow::Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            risk,
            concurrency,
            safety_notes: Vec::new(),
            executor: Arc::new(executor),
        }
    }

    pub fn with_safety_notes(
        mut self,
        safety_notes: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.safety_notes = safety_notes.into_iter().map(Into::into).collect();
        self
    }

    fn policy(&self) -> ToolPolicy {
        ToolPolicy {
            name: self.name.clone(),
            risk: self.risk,
            concurrency: self.concurrency,
            safety_notes: self.safety_notes.clone(),
        }
    }
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDefinition>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: ToolDefinition) -> anyhow::Result<()> {
        if self.tools.contains_key(&tool.name) {
            anyhow::bail!("Tool already registered: {}", tool.name);
        }
        self.tools.insert(tool.name.clone(), tool);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<&ToolDefinition> {
        self.tools.get(name)
    }

    pub fn list(&self) -> Vec<&ToolDefinition> {
        self.tools.values().collect()
    }

    pub fn metadata(&self) -> Vec<ToolMetadata> {
        self.tools.values().map(ToolMetadata::from_tool).collect()
    }

    pub fn execute(
        &self,
        call: &ToolCall,
        session: &SessionState,
    ) -> anyhow::Result<ToolExecutionResult> {
        let Some(tool) = self.get(&call.name) else {
            return Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: false,
                output: None,
                error: Some(format!("Unknown tool: {}", call.name)),
                safety_evidence: None,
            });
        };

        let decision = PermissionEngine::new(session.permission_mode).decide(&tool.policy(), None);
        if decision.status != PermissionStatus::Allowed {
            return Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: false,
                output: None,
                error: Some(decision.reason.clone()),
                safety_evidence: Some(ToolSafetyEvidence {
                    tool_name: call.name.clone(),
                    source: ToolSafetyEvidenceSource::PermissionEngine,
                    status: decision.status,
                    reason: decision.reason.clone(),
                    decision: Some(decision),
                }),
            });
        }

        match (tool.executor)(call.input.clone()) {
            Ok(output) => Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: true,
                output: Some(output),
                error: None,
                safety_evidence: None,
            }),
            Err(error) => Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: false,
                output: None,
                error: Some(error.to_string()),
                safety_evidence: None,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMetadata {
    pub name: String,
    pub description: String,
    pub risk: ToolRisk,
    pub risk_summary: String,
    pub concurrency: ToolConcurrency,
    pub permission_profiles: BTreeMap<PermissionMode, PermissionProfileMetadata>,
    pub permission: BTreeMap<PermissionMode, PermissionStatus>,
    pub permission_reasons: BTreeMap<PermissionMode, String>,
    pub permission_risk_metadata: BTreeMap<PermissionMode, Option<PermissionRiskMetadata>>,
    pub safety_notes: Vec<String>,
}

impl ToolMetadata {
    fn from_tool(tool: &ToolDefinition) -> Self {
        let profiles = PermissionEngine::describe_profiles(&tool.policy());
        Self {
            name: tool.name.clone(),
            description: tool.description.clone(),
            risk: tool.risk,
            risk_summary: risk_summary(tool.risk).to_string(),
            concurrency: tool.concurrency,
            permission: permission_modes()
                .into_iter()
                .map(|mode| (mode, profiles[&mode].status))
                .collect(),
            permission_reasons: permission_modes()
                .into_iter()
                .map(|mode| (mode, profiles[&mode].reason.clone()))
                .collect(),
            permission_risk_metadata: permission_modes()
                .into_iter()
                .map(|mode| (mode, profiles[&mode].risk_metadata.clone()))
                .collect(),
            permission_profiles: profiles,
            safety_notes: tool.safety_notes.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionResult {
    pub call_id: String,
    pub tool_name: String,
    pub ok: bool,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub safety_evidence: Option<ToolSafetyEvidence>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSafetyEvidence {
    pub tool_name: String,
    pub source: ToolSafetyEvidenceSource,
    pub status: PermissionStatus,
    pub reason: String,
    pub decision: Option<crate::PermissionDecision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSafetyEvidenceSource {
    PermissionEngine,
}

pub fn create_echo_tool() -> ToolDefinition {
    ToolDefinition::new(
        "echo",
        "Return text unchanged. Used for runtime and SDK smoke tests.",
        ToolRisk::Read,
        ToolConcurrency::ParallelSafe,
        |input| {
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("echo input requires a string text field"))?;
            Ok(json!({ "text": text }))
        },
    )
}

pub fn create_default_tool_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    registry
        .register(create_echo_tool())
        .expect("echo tool name is unique");
    registry
}

fn risk_summary(risk: ToolRisk) -> &'static str {
    match risk {
        ToolRisk::Read => "Read-only tool: inspects workspace state without writing.",
        ToolRisk::Write => "Write tool: can modify workspace files or state.",
        ToolRisk::Shell => {
            "Shell tool: executes local commands and is approval-gated outside yolo mode."
        }
        ToolRisk::Network => "Network tool: can contact external services.",
        ToolRisk::Dangerous => {
            "Dangerous tool: high-impact action requiring explicit approval outside yolo mode."
        }
    }
}

#[allow(dead_code)]
fn _labels_are_exported_for_catalog_parity(
    risk: ToolRisk,
    concurrency: ToolConcurrency,
) -> (&'static str, &'static str) {
    (risk_label(risk), concurrency_label(concurrency))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        PermissionMode, PermissionStatus, SessionState, ToolCall, ToolRisk, assistant_message,
        user_message,
    };
    use serde_json::json;
    use std::path::PathBuf;

    fn session(mode: PermissionMode) -> SessionState {
        SessionState {
            id: "session-rs".to_string(),
            cwd: PathBuf::from("."),
            permission_mode: mode,
            messages: vec![user_message("echo: hi"), assistant_message("calling echo")],
        }
    }

    #[test]
    fn default_registry_catalog_matches_ts_tool_metadata_contract() {
        let registry = create_default_tool_registry();
        let catalog = registry.metadata();
        let echo = catalog
            .iter()
            .find(|tool| tool.name == "echo")
            .expect("echo tool is registered");

        assert_eq!(echo.risk, ToolRisk::Read);
        assert_eq!(echo.concurrency, ToolConcurrency::ParallelSafe);
        assert_eq!(
            echo.permission_profiles[&PermissionMode::Default].status,
            PermissionStatus::Allowed
        );
        assert_eq!(
            echo.permission_profiles[&PermissionMode::Safe]
                .risk_metadata
                .as_ref()
                .unwrap()
                .concurrency,
            ToolConcurrency::ParallelSafe
        );

        let value = serde_json::to_value(echo).unwrap();
        assert_eq!(value["risk"], "read");
        assert_eq!(value["concurrency"], "parallel_safe");
        assert_eq!(
            value["permissionProfiles"]["default"]["riskMetadata"]["toolRisk"],
            "read"
        );
        assert_eq!(value["permission"]["default"], "allowed");
    }

    #[test]
    fn echo_tool_returns_text_unchanged() {
        let registry = create_default_tool_registry();
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-echo".to_string(),
                    name: "echo".to_string(),
                    input: json!({ "text": "hello rust" }),
                },
                &session(PermissionMode::Safe),
            )
            .unwrap();

        assert!(result.ok);
        assert_eq!(result.output, Some(json!({ "text": "hello rust" })));
        assert!(result.safety_evidence.is_none());
    }

    #[test]
    fn denied_tool_call_does_not_execute_and_returns_safety_evidence() {
        let mut registry = ToolRegistry::new();
        registry
            .register(ToolDefinition::new(
                "write_probe",
                "test write tool",
                ToolRisk::Write,
                ToolConcurrency::Exclusive,
                |_input| Ok(json!({ "executed": true })),
            ))
            .unwrap();

        let result = registry
            .execute(
                &ToolCall {
                    id: "call-write".to_string(),
                    name: "write_probe".to_string(),
                    input: json!({}),
                },
                &session(PermissionMode::Safe),
            )
            .unwrap();

        assert!(!result.ok);
        assert_eq!(result.output, None);
        assert_eq!(
            result.safety_evidence.as_ref().unwrap().source,
            ToolSafetyEvidenceSource::PermissionEngine
        );
        assert_eq!(
            result.safety_evidence.as_ref().unwrap().status,
            PermissionStatus::Denied
        );
    }

    #[test]
    fn registry_rejects_duplicates_and_unknown_calls_fail_closed() {
        let mut registry = ToolRegistry::new();
        registry.register(create_echo_tool()).unwrap();

        let duplicate = registry.register(create_echo_tool()).unwrap_err();
        assert!(
            duplicate
                .to_string()
                .contains("Tool already registered: echo")
        );

        let result = registry
            .execute(
                &ToolCall {
                    id: "missing".to_string(),
                    name: "missing_tool".to_string(),
                    input: json!({}),
                },
                &session(PermissionMode::Yolo),
            )
            .unwrap();

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("Unknown tool: missing_tool"));
    }
}
