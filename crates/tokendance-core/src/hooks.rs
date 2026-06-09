use crate::{PermissionDecision, ToolCall, ToolResult};
use serde_json::Value;

/// Hook point in the agent lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookPoint {
    /// Before a tool is executed
    PreToolUse,
    /// After a tool has been executed
    PostToolUse,
    /// After a turn completes
    TurnCompleted,
    /// After a turn fails
    TurnFailed,
}

/// The context passed to a hook.
#[derive(Debug, Clone)]
pub struct HookContext {
    pub session_id: String,
    pub turn_id: String,
    pub tool_call: Option<ToolCall>,
    pub tool_result: Option<ToolResult>,
    pub decision: Option<PermissionDecision>,
}

/// Result of running a hook.
#[derive(Debug, Clone)]
pub enum HookResult {
    /// Continue execution normally
    Continue,
    /// Block the action with a reason
    Block { reason: String },
    /// Modify the input (for PreToolUse hooks)
    Modify { modified_input: Value },
}

/// A hook callback.
pub type HookFn = Box<dyn Fn(&HookContext) -> HookResult + Send + Sync>;

/// Registry of lifecycle hooks.
pub struct HookRegistry {
    pre_tool_use: Vec<HookFn>,
    post_tool_use: Vec<HookFn>,
    turn_completed: Vec<HookFn>,
    turn_failed: Vec<HookFn>,
}

impl std::fmt::Debug for HookRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookRegistry")
            .field(
                "pre_tool_use",
                &format!("{} hooks", self.pre_tool_use.len()),
            )
            .field(
                "post_tool_use",
                &format!("{} hooks", self.post_tool_use.len()),
            )
            .field(
                "turn_completed",
                &format!("{} hooks", self.turn_completed.len()),
            )
            .field("turn_failed", &format!("{} hooks", self.turn_failed.len()))
            .finish()
    }
}

impl Default for HookRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl HookRegistry {
    pub fn new() -> Self {
        Self {
            pre_tool_use: Vec::new(),
            post_tool_use: Vec::new(),
            turn_completed: Vec::new(),
            turn_failed: Vec::new(),
        }
    }

    /// Register a hook at a specific point.
    pub fn register(&mut self, point: HookPoint, hook: HookFn) {
        match point {
            HookPoint::PreToolUse => self.pre_tool_use.push(hook),
            HookPoint::PostToolUse => self.post_tool_use.push(hook),
            HookPoint::TurnCompleted => self.turn_completed.push(hook),
            HookPoint::TurnFailed => self.turn_failed.push(hook),
        }
    }

    /// Run all hooks for a point, returning the combined result.
    /// If any hook returns Block, the action is blocked.
    /// If any hook returns Modify, the last modification wins.
    /// Otherwise returns Continue.
    pub fn run(&self, point: HookPoint, context: &HookContext) -> HookResult {
        let hooks = match point {
            HookPoint::PreToolUse => &self.pre_tool_use,
            HookPoint::PostToolUse => &self.post_tool_use,
            HookPoint::TurnCompleted => &self.turn_completed,
            HookPoint::TurnFailed => &self.turn_failed,
        };

        let mut result = HookResult::Continue;
        for hook in hooks {
            match hook(context) {
                HookResult::Continue => {}
                HookResult::Block { .. } => {
                    // Block takes precedence — return immediately.
                    return hook(context);
                }
                HookResult::Modify { modified_input } => {
                    result = HookResult::Modify { modified_input };
                }
            }
        }
        result
    }

    /// Returns the total number of registered hooks.
    pub fn len(&self) -> usize {
        self.pre_tool_use.len()
            + self.post_tool_use.len()
            + self.turn_completed.len()
            + self.turn_failed.len()
    }

    /// Returns true if no hooks are registered.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PermissionStatus;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn test_context() -> HookContext {
        HookContext {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            tool_call: Some(ToolCall {
                id: "call-1".to_string(),
                name: "echo".to_string(),
                input: json!({ "text": "hello" }),
            }),
            tool_result: None,
            decision: Some(PermissionDecision {
                status: PermissionStatus::Allowed,
                reason: "allowed".to_string(),
                risk_metadata: None,
                mode: crate::PermissionMode::Default,
                tool_name: "echo".to_string(),
                subject: None,
            }),
        }
    }

    #[test]
    fn register_and_run_continue_hook() {
        let mut registry = HookRegistry::new();
        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();
        registry.register(
            HookPoint::PreToolUse,
            Box::new(move |_ctx| {
                *called_clone.lock().unwrap() = true;
                HookResult::Continue
            }),
        );

        let result = registry.run(HookPoint::PreToolUse, &test_context());
        assert!(matches!(result, HookResult::Continue));
        assert!(*called.lock().unwrap());
    }

    #[test]
    fn block_result_prevents_execution() {
        let mut registry = HookRegistry::new();
        registry.register(
            HookPoint::PreToolUse,
            Box::new(|_ctx| HookResult::Block {
                reason: "forbidden".to_string(),
            }),
        );

        let result = registry.run(HookPoint::PreToolUse, &test_context());
        match result {
            HookResult::Block { reason } => assert_eq!(reason, "forbidden"),
            other => panic!("expected Block, got {:?}", other),
        }
    }

    #[test]
    fn modify_result_changes_input() {
        let mut registry = HookRegistry::new();
        registry.register(
            HookPoint::PreToolUse,
            Box::new(|_ctx| HookResult::Modify {
                modified_input: json!({ "text": "modified" }),
            }),
        );

        let result = registry.run(HookPoint::PreToolUse, &test_context());
        match result {
            HookResult::Modify { modified_input } => {
                assert_eq!(modified_input["text"], "modified");
            }
            other => panic!("expected Modify, got {:?}", other),
        }
    }

    #[test]
    fn last_modify_wins_when_multiple_modifiers() {
        let mut registry = HookRegistry::new();
        registry.register(
            HookPoint::PreToolUse,
            Box::new(|_ctx| HookResult::Modify {
                modified_input: json!({ "text": "first" }),
            }),
        );
        registry.register(
            HookPoint::PreToolUse,
            Box::new(|_ctx| HookResult::Modify {
                modified_input: json!({ "text": "second" }),
            }),
        );

        let result = registry.run(HookPoint::PreToolUse, &test_context());
        match result {
            HookResult::Modify { modified_input } => {
                assert_eq!(modified_input["text"], "second");
            }
            other => panic!("expected Modify, got {:?}", other),
        }
    }

    #[test]
    fn block_takes_precedence_over_continue() {
        let mut registry = HookRegistry::new();
        registry.register(HookPoint::PreToolUse, Box::new(|_ctx| HookResult::Continue));
        registry.register(
            HookPoint::PreToolUse,
            Box::new(|_ctx| HookResult::Block {
                reason: "blocked".to_string(),
            }),
        );

        let result = registry.run(HookPoint::PreToolUse, &test_context());
        assert!(matches!(result, HookResult::Block { .. }));
    }

    #[test]
    fn hooks_run_on_correct_point() {
        let mut registry = HookRegistry::new();
        let pre_called = Arc::new(Mutex::new(false));
        let post_called = Arc::new(Mutex::new(false));
        let pre_clone = pre_called.clone();
        let post_clone = post_called.clone();

        registry.register(
            HookPoint::PreToolUse,
            Box::new(move |_ctx| {
                *pre_clone.lock().unwrap() = true;
                HookResult::Continue
            }),
        );
        registry.register(
            HookPoint::PostToolUse,
            Box::new(move |_ctx| {
                *post_clone.lock().unwrap() = true;
                HookResult::Continue
            }),
        );

        registry.run(HookPoint::PreToolUse, &test_context());
        assert!(*pre_called.lock().unwrap());
        assert!(!*post_called.lock().unwrap());
    }

    #[test]
    fn is_empty_and_len() {
        let mut registry = HookRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);

        registry.register(
            HookPoint::TurnCompleted,
            Box::new(|_ctx| HookResult::Continue),
        );
        assert!(!registry.is_empty());
        assert_eq!(registry.len(), 1);

        registry.register(HookPoint::TurnFailed, Box::new(|_ctx| HookResult::Continue));
        assert_eq!(registry.len(), 2);
    }
}
