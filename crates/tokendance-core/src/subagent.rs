use crate::{
    Message, ModelProvider, PermissionMode, ProviderRequest, Runtime, SessionState, ToolResult,
    assistant_message, user_message,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

/// Names of tools that subagents are never allowed to use, to prevent recursion.
const RECURSION_BLOCKED_TOOLS: &[&str] = &["subagent", "run_subagent", "agent"];

/// Configuration for spawning a subagent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentConfig {
    /// A descriptive name for this subagent type.
    pub name: String,
    /// System prompt / instructions for the subagent.
    pub prompt: String,
    /// Allowed tools (subset of parent's tools). Empty means all tools available.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// Disallowed tools.
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    /// Maximum turns the subagent can take.
    #[serde(default = "default_max_turns")]
    pub max_turns: usize,
    /// Permission mode for the subagent. Can be more restrictive than parent.
    pub permission_mode: PermissionMode,
    /// Model to use (None = inherit from parent).
    #[serde(default)]
    pub model: Option<String>,
    /// Working directory (None = inherit from parent).
    #[serde(default)]
    pub working_directory: Option<PathBuf>,
}

fn default_max_turns() -> usize {
    10
}

/// Result of a subagent execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentResult {
    pub subagent_id: String,
    pub name: String,
    pub success: bool,
    pub response: String,
    pub turns_completed: usize,
    pub tools_used: Vec<String>,
    pub error: Option<String>,
}

/// Build the excluded-tools list: user-specified disallowed tools plus the
/// recursion-prevention set.
fn build_excluded_list(disallowed: &[String]) -> Vec<String> {
    let mut excluded: Vec<String> = disallowed.to_vec();
    for name in RECURSION_BLOCKED_TOOLS {
        if !excluded.iter().any(|e| e == *name) {
            excluded.push((*name).to_string());
        }
    }
    excluded
}

/// Spawns and runs a subagent to completion.
/// The subagent gets its own session and restricted tool set,
/// but shares the parent's provider (model backend).
pub async fn run_subagent<P: ModelProvider>(
    parent_runtime: &Runtime<P>,
    config: SubagentConfig,
    task: String,
) -> anyhow::Result<SubagentResult> {
    let subagent_id = format!("sub-{}-{}", config.name, Uuid::new_v4());

    // 1. Create a filtered tool registry (only allowed tools, exclude recursion tools)
    let excluded = build_excluded_list(&config.disallowed_tools);
    let filtered_tools = parent_runtime
        .tools()
        .filter_by_names(&config.allowed_tools, &excluded);

    // 2. Build a fresh session for the subagent
    let working_directory = config
        .working_directory
        .clone()
        .unwrap_or_else(|| parent_runtime.storage_root().to_path_buf());
    let mut session = SessionState {
        id: subagent_id.clone(),
        cwd: working_directory,
        permission_mode: config.permission_mode,
        messages: Vec::new(),
    };

    // 3. Prepend subagent prompt as a system context message
    session.messages.push(Message {
        role: "system".to_string(),
        content: config.prompt.clone(),
    });

    // 4. Add the user task
    let full_prompt = format!("[Subagent: {}] {}", config.name, task);
    session.messages.push(user_message(full_prompt.clone()));

    // 5. Run the subagent for up to max_turns
    let mut turns_completed = 0usize;
    let mut tools_used = Vec::new();
    let mut final_response = String::new();
    let mut last_error: Option<String> = None;

    for _turn in 0..config.max_turns {
        // Call the provider
        let response = match parent_runtime
            .provider()
            .create_turn(ProviderRequest {
                session: session.clone(),
                tool_results: Vec::new(),
            })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(e.to_string());
                break;
            }
        };

        turns_completed += 1;

        // If no tool calls, we're done — store the assistant message
        if response.tool_calls.is_empty() {
            let msg = response.assistant_message.clone().unwrap_or_default();
            session.messages.push(assistant_message(&msg));
            final_response = msg;
            break;
        }

        // Store assistant message if present
        if let Some(ref msg) = response.assistant_message {
            session.messages.push(assistant_message(msg));
        }

        // Execute tool calls
        let mut tool_results = Vec::new();
        for call in &response.tool_calls {
            if !tools_used.contains(&call.name) {
                tools_used.push(call.name.clone());
            }
            let decision = filtered_tools.permission_decision(call, &session);
            let result = filtered_tools.execute_with_decision(call, &decision, &session);
            match result {
                Ok(exec_result) => {
                    tool_results.push(ToolResult {
                        call_id: exec_result.call_id,
                        tool_name: exec_result.tool_name,
                        ok: exec_result.ok,
                        output: exec_result.output,
                        error: exec_result.error,
                    });
                }
                Err(e) => {
                    tool_results.push(ToolResult {
                        call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        ok: false,
                        output: None,
                        error: Some(e.to_string()),
                    });
                }
            }
        }

        // Now do a follow-up call with tool results to get the final response
        let followup = match parent_runtime
            .provider()
            .create_turn(ProviderRequest {
                session: session.clone(),
                tool_results,
            })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(e.to_string());
                break;
            }
        };

        turns_completed += 1;
        let msg = followup.assistant_message.clone().unwrap_or_default();
        session.messages.push(assistant_message(&msg));
        final_response = msg;

        // If the follow-up has no more tool calls, we're done
        if followup.tool_calls.is_empty() {
            break;
        }
        // Otherwise the loop continues (complex multi-step tool chains)
    }

    let success = last_error.is_none();
    Ok(SubagentResult {
        subagent_id,
        name: config.name,
        success,
        response: final_response,
        turns_completed,
        tools_used,
        error: last_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        MockProvider, PermissionMode, ToolConcurrency, ToolDefinition, ToolRisk,
        create_default_tool_registry,
    };
    use serde_json::json;

    #[test]
    fn subagent_config_deserializes_from_json() {
        let json = r#"{
            "name": "code-reviewer",
            "prompt": "You are a code reviewer.",
            "allowed_tools": ["read_file", "grep"],
            "disallowed_tools": ["run_powershell"],
            "max_turns": 5,
            "permission_mode": "safe",
            "model": null,
            "working_directory": null
        }"#;
        let config: SubagentConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.name, "code-reviewer");
        assert_eq!(config.prompt, "You are a code reviewer.");
        assert_eq!(config.allowed_tools, vec!["read_file", "grep"]);
        assert_eq!(config.disallowed_tools, vec!["run_powershell"]);
        assert_eq!(config.max_turns, 5);
        assert_eq!(config.permission_mode, PermissionMode::Safe);
        assert!(config.model.is_none());
        assert!(config.working_directory.is_none());
    }

    #[test]
    fn filtered_tool_registry_excludes_disallowed() {
        let registry = create_default_tool_registry();
        let allowed = vec!["read_file".to_string(), "echo".to_string()];
        let disallowed = vec!["read_file".to_string()];
        let filtered = registry.filter_by_names(&allowed, &disallowed);

        // read_file is both allowed and disallowed — disallowed wins
        assert!(filtered.get("read_file").is_none());
        // echo is allowed and not disallowed
        assert!(filtered.get("echo").is_some());
        // write_file is not in allowed list
        assert!(filtered.get("write_file").is_none());
    }

    #[tokio::test]
    async fn subagent_runs_and_returns_result() {
        let root = std::env::temp_dir().join(format!("tdcode-subagent-test-{}", Uuid::new_v4()));
        let runtime = Runtime::new(MockProvider, root.clone());

        let config = SubagentConfig {
            name: "test-agent".to_string(),
            prompt: "You are a test agent.".to_string(),
            allowed_tools: vec![],
            disallowed_tools: vec![],
            max_turns: 3,
            permission_mode: PermissionMode::Default,
            model: None,
            working_directory: Some(root.clone()),
        };

        let result = run_subagent(&runtime, config, "hello world".to_string())
            .await
            .unwrap();

        assert!(result.success);
        assert!(
            result.response.contains("hello world"),
            "response should contain 'hello world', got: {:?}",
            result.response
        );
        assert!(result.turns_completed >= 1);
        assert!(result.error.is_none());
        assert!(result.subagent_id.starts_with("sub-test-agent-"));
    }

    #[tokio::test]
    async fn subagent_enforces_max_turns() {
        let root =
            std::env::temp_dir().join(format!("tdcode-subagent-maxturns-{}", Uuid::new_v4()));
        let runtime = Runtime::new(MockProvider, root.clone());

        let config = SubagentConfig {
            name: "limited-agent".to_string(),
            prompt: "You are a limited agent.".to_string(),
            allowed_tools: vec![],
            disallowed_tools: vec![],
            max_turns: 1,
            permission_mode: PermissionMode::Default,
            model: None,
            working_directory: Some(root.clone()),
        };

        let result = run_subagent(&runtime, config, "do something".to_string())
            .await
            .unwrap();

        // MockProvider responds without tool calls, so only 1 turn is needed
        assert!(result.success);
        assert!(
            result.turns_completed <= 2,
            "turns should be bounded: got {}",
            result.turns_completed
        );
    }

    #[test]
    fn subagent_prevents_recursion() {
        let mut registry = create_default_tool_registry();
        // Register a fake "subagent" tool to verify it gets filtered out
        registry
            .register(ToolDefinition::new(
                "subagent",
                "Spawn a subagent (should be blocked)",
                ToolRisk::Dangerous,
                ToolConcurrency::Serial,
                |_input| Ok(json!({})),
            ))
            .unwrap();

        let excluded = build_excluded_list(&[]);
        let filtered = registry.filter_by_names(&[], &excluded);

        // The subagent tool must not appear in the filtered registry
        assert!(
            filtered.get("subagent").is_none(),
            "subagent tool should be excluded to prevent recursion"
        );
        // Other tools should still be present
        assert!(filtered.get("echo").is_some());
    }
}
