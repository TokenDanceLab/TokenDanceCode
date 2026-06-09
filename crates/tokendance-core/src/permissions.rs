use crate::{
    PermissionApprovalScope, PermissionDecision, PermissionDecisionAction, PermissionMode,
    PermissionRiskMetadata, PermissionStatus, ToolConcurrency, ToolRisk,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPolicy {
    pub name: String,
    pub risk: ToolRisk,
    pub concurrency: ToolConcurrency,
    pub safety_notes: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct PermissionEngine {
    mode: PermissionMode,
}

impl PermissionEngine {
    pub fn new(mode: PermissionMode) -> Self {
        Self { mode }
    }

    pub fn describe_profiles(
        tool: &ToolPolicy,
    ) -> BTreeMap<PermissionMode, PermissionProfileMetadata> {
        permission_modes()
            .into_iter()
            .map(|mode| {
                let decision = Self::new(mode).decide(tool, None);
                (
                    mode,
                    PermissionProfileMetadata {
                        status: decision.status,
                        reason: decision.reason,
                        risk_metadata: decision.risk_metadata,
                    },
                )
            })
            .collect()
    }

    pub fn decide(&self, tool: &ToolPolicy, subject: Option<&str>) -> PermissionDecision {
        let (status, detail) = match self.mode {
            PermissionMode::Yolo => (
                PermissionStatus::Allowed,
                "yolo mode allows registered tools; tool execution guards may still hard-deny unsafe inputs".to_string(),
            ),
            PermissionMode::Auto => {
                if tool.risk == ToolRisk::Dangerous {
                    (
                        PermissionStatus::RequiresApproval,
                        "auto mode requires approval before running dangerous tools".to_string(),
                    )
                } else {
                    (
                        PermissionStatus::Allowed,
                        "auto mode allows non-dangerous registered tools".to_string(),
                    )
                }
            }
            PermissionMode::Default => {
                if tool.risk == ToolRisk::Read {
                    (
                        PermissionStatus::Allowed,
                        "default mode allows read-only tools".to_string(),
                    )
                } else {
                    (
                        PermissionStatus::RequiresApproval,
                        format!(
                            "default mode requires approval before running {} tools",
                            risk_label(tool.risk)
                        ),
                    )
                }
            }
            PermissionMode::Safe => {
                if tool.risk == ToolRisk::Read {
                    (
                        PermissionStatus::Allowed,
                        "safe mode allows read-only tools".to_string(),
                    )
                } else {
                    (
                        PermissionStatus::Denied,
                        "safe mode only allows read-only tools".to_string(),
                    )
                }
            }
        };
        let action = action_for_status(status);
        let subject_suffix = subject
            .map(|value| format!(" subject={value}"))
            .unwrap_or_default();
        let audit_context = if subject.is_none() && !tool.safety_notes.is_empty() {
            format!(
                "; concurrency={}; safety={}",
                concurrency_label(tool.concurrency),
                tool.safety_notes.join(" ")
            )
        } else {
            String::new()
        };
        PermissionDecision {
            status,
            reason: format!(
                "mode={} tool={} risk={} action={}{}: {}{}",
                mode_label(self.mode),
                tool.name,
                risk_label(tool.risk),
                action_label(action),
                subject_suffix,
                detail,
                audit_context
            ),
            risk_metadata: Some(PermissionRiskMetadata {
                mode: self.mode,
                tool_name: tool.name.clone(),
                tool_risk: tool.risk,
                action,
                approval_scope: if action == PermissionDecisionAction::ApprovalRequired {
                    PermissionApprovalScope::ToolCall
                } else {
                    PermissionApprovalScope::None
                },
                concurrency: tool.concurrency,
                safety_notes: tool.safety_notes.clone(),
            }),
            mode: self.mode,
            tool_name: tool.name.clone(),
            subject: subject.map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileMetadata {
    pub status: PermissionStatus,
    pub reason: String,
    pub risk_metadata: Option<PermissionRiskMetadata>,
}

pub fn permission_modes() -> [PermissionMode; 4] {
    [
        PermissionMode::Default,
        PermissionMode::Safe,
        PermissionMode::Auto,
        PermissionMode::Yolo,
    ]
}

fn action_for_status(status: PermissionStatus) -> PermissionDecisionAction {
    match status {
        PermissionStatus::Allowed => PermissionDecisionAction::Allowed,
        PermissionStatus::RequiresApproval => PermissionDecisionAction::ApprovalRequired,
        PermissionStatus::Denied => PermissionDecisionAction::Denied,
    }
}

fn mode_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "default",
        PermissionMode::Safe => "safe",
        PermissionMode::Auto => "auto",
        PermissionMode::Yolo => "yolo",
    }
}

pub fn risk_label(risk: ToolRisk) -> &'static str {
    match risk {
        ToolRisk::Read => "read",
        ToolRisk::Write => "write",
        ToolRisk::Shell => "shell",
        ToolRisk::Network => "network",
        ToolRisk::Dangerous => "dangerous",
    }
}

pub fn concurrency_label(concurrency: ToolConcurrency) -> &'static str {
    match concurrency {
        ToolConcurrency::Serial => "serial",
        ToolConcurrency::ParallelSafe => "parallel_safe",
        ToolConcurrency::Exclusive => "exclusive",
    }
}

fn action_label(action: PermissionDecisionAction) -> &'static str {
    match action {
        PermissionDecisionAction::Allowed => "allowed",
        PermissionDecisionAction::Denied => "denied",
        PermissionDecisionAction::ApprovalRequired => "approval_required",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_mode_denies_risky_tools() {
        let engine = PermissionEngine::new(PermissionMode::Safe);
        let decision = engine.decide(
            &ToolPolicy {
                name: "run_powershell".to_string(),
                risk: ToolRisk::Shell,
                concurrency: ToolConcurrency::Exclusive,
                safety_notes: Vec::new(),
            },
            Some("Remove-Item"),
        );
        assert_eq!(decision.status, PermissionStatus::Denied);
        assert!(decision.reason.contains("subject=Remove-Item"));
    }
}
