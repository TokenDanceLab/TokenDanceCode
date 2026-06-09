use crate::{PermissionDecision, PermissionMode, PermissionStatus, ToolRisk};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPolicy {
    pub name: String,
    pub risk: ToolRisk,
}

#[derive(Debug, Default, Clone)]
pub struct PermissionEngine {
    mode: PermissionMode,
}

impl PermissionEngine {
    pub fn new(mode: PermissionMode) -> Self {
        Self { mode }
    }

    pub fn decide(&self, tool: &ToolPolicy, subject: Option<&str>) -> PermissionDecision {
        let status = match self.mode {
            PermissionMode::Yolo => PermissionStatus::Allowed,
            PermissionMode::Auto => match tool.risk {
                ToolRisk::Low | ToolRisk::Medium => PermissionStatus::Allowed,
                ToolRisk::High => PermissionStatus::RequiresApproval,
            },
            PermissionMode::Default => match tool.risk {
                ToolRisk::Low => PermissionStatus::Allowed,
                ToolRisk::Medium | ToolRisk::High => PermissionStatus::RequiresApproval,
            },
            PermissionMode::Safe => match tool.risk {
                ToolRisk::Low => PermissionStatus::Allowed,
                ToolRisk::Medium | ToolRisk::High => PermissionStatus::Denied,
            },
        };
        let action = match status {
            PermissionStatus::Allowed => "allowed",
            PermissionStatus::RequiresApproval => "approval_required",
            PermissionStatus::Denied => "denied",
        };
        let subject_suffix = subject
            .map(|value| format!(" subject={value}"))
            .unwrap_or_default();
        PermissionDecision {
            status,
            reason: format!(
                "mode={:?} tool={} risk={:?} action={}{}",
                self.mode, tool.name, tool.risk, action, subject_suffix
            ),
            mode: self.mode,
            tool_name: tool.name.clone(),
            subject: subject.map(str::to_string),
        }
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
                risk: ToolRisk::High,
            },
            Some("Remove-Item"),
        );
        assert_eq!(decision.status, PermissionStatus::Denied);
        assert!(decision.reason.contains("subject=Remove-Item"));
    }
}
