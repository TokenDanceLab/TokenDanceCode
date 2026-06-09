use crate::{Message, SessionState};
use serde::{Deserialize, Serialize};

/// Configuration for compaction behavior.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactConfig {
    /// Maximum messages before compaction triggers.
    #[serde(default = "default_max_messages")]
    pub max_messages: usize,
    /// Number of recent messages to keep unsummarized.
    #[serde(default = "default_keep_recent")]
    pub keep_recent: usize,
    /// Whether compaction is enabled.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_max_messages() -> usize {
    100
}
fn default_keep_recent() -> usize {
    10
}
fn default_enabled() -> bool {
    true
}

impl Default for CompactConfig {
    fn default() -> Self {
        Self {
            max_messages: default_max_messages(),
            keep_recent: default_keep_recent(),
            enabled: default_enabled(),
        }
    }
}

/// Result of a compaction operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactResult {
    /// The summary that replaced older messages.
    pub summary: String,
    /// Number of messages that were compacted.
    pub messages_compacted: usize,
    /// Number of messages kept.
    pub messages_kept: usize,
    /// Tokens saved (estimated).
    pub estimated_tokens_saved: usize,
}

/// Check if a session needs compaction.
pub fn needs_compaction(session: &SessionState, config: &CompactConfig) -> bool {
    config.enabled && session.messages.len() > config.max_messages
}

/// Compact a session's message history.
/// Keeps the most recent `keep_recent` messages, replaces the rest with a summary.
/// Returns `None` if compaction is not needed.
pub fn compact_session(
    session: &mut SessionState,
    config: &CompactConfig,
) -> Option<CompactResult> {
    // 1. Check if compaction needed
    if !needs_compaction(session, config) {
        return None;
    }

    let total = session.messages.len();
    if total <= config.keep_recent {
        return None;
    }

    // 2. Split messages: old = [0..len-keep_recent], recent = [len-keep_recent..]
    let split_point = total - config.keep_recent;
    let old_messages: Vec<Message> = session.messages.drain(..split_point).collect();
    let messages_compacted = old_messages.len();

    // 3-4. Generate a summary and create a summary message
    let summary = generate_summary(&old_messages);
    let estimated_tokens_saved = estimate_tokens(&old_messages);
    let summary_message = Message {
        role: "system".to_string(),
        content: summary.clone(),
    };

    // 5. Replace session.messages with [summary_message] + remaining recent messages
    let mut new_messages = vec![summary_message];
    new_messages.append(&mut session.messages);
    session.messages = new_messages;

    let messages_kept = session.messages.len();

    // 6. Return CompactResult
    Some(CompactResult {
        summary,
        messages_compacted,
        messages_kept,
        estimated_tokens_saved,
    })
}

/// Generate a summary from a list of messages.
/// This is a simple heuristic summary (no LLM call).
/// For production, this would call the model to summarize.
fn generate_summary(messages: &[Message]) -> String {
    let user_count = messages.iter().filter(|m| m.role == "user").count();
    let assistant_count = messages.iter().filter(|m| m.role == "assistant").count();

    // Extract first line of each message as a brief summary
    let mut lines = Vec::new();
    for msg in messages {
        let first_line = msg.content.lines().next().unwrap_or("");
        let truncated = if first_line.len() > 100 {
            format!("{}...", &first_line[..97])
        } else {
            first_line.to_string()
        };
        lines.push(format!("- [{}] {}", msg.role, truncated));
    }

    format!(
        "[Compacted {} messages ({} user, {} assistant)]\n{}",
        messages.len(),
        user_count,
        assistant_count,
        lines.join("\n")
    )
}

/// Estimate token count from message content (rough: 1 token per 4 chars).
fn estimate_tokens(messages: &[Message]) -> usize {
    messages.iter().map(|m| m.content.len() / 4).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PermissionMode, SessionState, assistant_message, user_message};
    use std::path::PathBuf;

    fn test_session(message_count: usize) -> SessionState {
        let mut messages = Vec::new();
        for i in 0..message_count {
            if i % 2 == 0 {
                messages.push(user_message(format!("user message {}", i)));
            } else {
                messages.push(assistant_message(format!("assistant message {}", i)));
            }
        }
        SessionState {
            id: "session-compact-test".to_string(),
            cwd: PathBuf::from("."),
            permission_mode: PermissionMode::Default,
            messages,
        }
    }

    #[test]
    fn compact_config_default_values() {
        let config = CompactConfig::default();
        assert_eq!(config.max_messages, 100);
        assert_eq!(config.keep_recent, 10);
        assert!(config.enabled);
    }

    #[test]
    fn needs_compaction_below_threshold() {
        let session = test_session(50);
        let config = CompactConfig::default();
        assert!(!needs_compaction(&session, &config));
    }

    #[test]
    fn needs_compaction_above_threshold() {
        let session = test_session(150);
        let config = CompactConfig::default();
        assert!(needs_compaction(&session, &config));
    }

    #[test]
    fn compact_session_reduces_message_count() {
        let mut session = test_session(120);
        let config = CompactConfig {
            max_messages: 100,
            keep_recent: 10,
            enabled: true,
        };

        let result = compact_session(&mut session, &config).unwrap();

        // 120 messages total, keep 10 recent + 1 summary = 11
        assert_eq!(session.messages.len(), 11);
        assert_eq!(result.messages_compacted, 110);
        assert!(result.estimated_tokens_saved > 0);
    }

    #[test]
    fn compact_session_keeps_recent_messages() {
        let mut session = test_session(120);
        let config = CompactConfig {
            max_messages: 100,
            keep_recent: 10,
            enabled: true,
        };

        let _result = compact_session(&mut session, &config).unwrap();

        // The last 10 messages should be preserved
        // Original messages 110-119 (indices) become messages 1-10 after the summary
        // The last user message was at index 118 (even), content "user message 118"
        // The last assistant message was at index 119 (odd), content "assistant message 119"
        let last_user = session
            .messages
            .iter()
            .find(|m| m.role == "user" && m.content.contains("118"));
        assert!(
            last_user.is_some(),
            "recent user message should be preserved"
        );

        let last_assistant = session
            .messages
            .iter()
            .find(|m| m.role == "assistant" && m.content.contains("119"));
        assert!(
            last_assistant.is_some(),
            "recent assistant message should be preserved"
        );
    }

    #[test]
    fn compact_session_returns_correct_counts() {
        let mut session = test_session(150);
        let config = CompactConfig {
            max_messages: 100,
            keep_recent: 20,
            enabled: true,
        };

        let result = compact_session(&mut session, &config).unwrap();

        // 150 total - 20 kept = 130 compacted, then 1 summary + 20 recent = 21 kept
        assert_eq!(result.messages_compacted, 130);
        assert_eq!(result.messages_kept, 21);
        assert!(result.summary.contains("130 messages"));
    }

    #[test]
    fn generate_summary_formats_correctly() {
        let long_message = "this is a very long message that definitely exceeds one hundred characters so it should be truncated with ellipsis at the end";
        assert!(
            long_message.len() > 100,
            "test message must exceed 100 chars"
        );

        let messages = vec![
            user_message("hello world"),
            assistant_message("hi there"),
            user_message(long_message),
        ];

        let summary = generate_summary(&messages);

        assert!(summary.contains("3 messages"));
        assert!(summary.contains("2 user"));
        assert!(summary.contains("1 assistant"));
        assert!(summary.contains("[user] hello world"));
        assert!(summary.contains("[assistant] hi there"));
        // Long message should be truncated
        assert!(summary.contains(&format!("{}...", &long_message[..97])));
    }

    #[test]
    fn disabled_compaction_never_triggers() {
        let session = test_session(500);
        let config = CompactConfig {
            max_messages: 100,
            keep_recent: 10,
            enabled: false,
        };

        assert!(!needs_compaction(&session, &config));

        let mut session_clone = session;
        let result = compact_session(&mut session_clone, &config);
        assert!(result.is_none());
    }
}
