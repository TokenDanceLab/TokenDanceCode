use crate::{Message, PermissionMode, RuntimeEvent, SessionState, assistant_message, user_message};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs::{OpenOptions, create_dir_all};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct TranscriptStore {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEnvelope {
    pub version: u8,
    pub seq: u64,
    pub uuid: String,
    #[serde(rename = "parentUuid", skip_serializing_if = "Option::is_none")]
    pub parent_uuid: Option<String>,
    pub timestamp: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub cwd: PathBuf,
    pub event: RuntimeEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptPosition {
    pub next_seq: u64,
    pub last_uuid: Option<String>,
}

/// Summary of a session, derived from its transcript and session file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    pub event_count: usize,
    pub turn_count: usize,
    pub cwd: Option<PathBuf>,
}

impl TranscriptStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn session_dir(&self, session_id: &str) -> PathBuf {
        self.root.join("sessions").join(session_id)
    }

    pub async fn save_session(&self, session: &SessionState) -> anyhow::Result<()> {
        let dir = self.session_dir(&session.id);
        create_dir_all(&dir).await?;
        let body = serde_json::to_vec_pretty(session)?;
        tokio::fs::write(dir.join("session.json"), body).await?;
        Ok(())
    }

    pub async fn append_event(
        &self,
        session_id: &str,
        cwd: &Path,
        seq: u64,
        parent_uuid: Option<String>,
        event: &RuntimeEvent,
    ) -> anyhow::Result<TranscriptEnvelope> {
        let dir = self.session_dir(session_id);
        create_dir_all(&dir).await?;
        let envelope = TranscriptEnvelope {
            version: 1,
            seq,
            uuid: Uuid::new_v4().to_string(),
            parent_uuid,
            timestamp: timestamp_now(),
            session_id: session_id.to_string(),
            turn_id: event_turn_id(event).map(str::to_string),
            cwd: cwd.to_path_buf(),
            event: event.clone(),
        };
        append_jsonl(dir.join("transcript.jsonl"), &envelope).await?;
        Ok(envelope)
    }

    pub fn resume_position(&self, session_id: &str) -> TranscriptPosition {
        let path = self.session_dir(session_id).join("transcript.jsonl");
        let Ok(content) = std::fs::read_to_string(path) else {
            return TranscriptPosition {
                next_seq: 1,
                last_uuid: None,
            };
        };

        let mut max_seq = 0;
        let mut last_uuid = None;
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if let Some(seq) = value.get("seq").and_then(serde_json::Value::as_u64) {
                max_seq = max_seq.max(seq);
            } else {
                max_seq += 1;
            }
            if let Some(uuid) = value.get("uuid").and_then(serde_json::Value::as_str) {
                last_uuid = Some(uuid.to_string());
            }
        }

        TranscriptPosition {
            next_seq: max_seq + 1,
            last_uuid,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// List all sessions in the store, sorted by most recently modified.
    pub async fn list_sessions(&self) -> anyhow::Result<Vec<SessionSummary>> {
        let sessions_dir = self.root.join("sessions");
        if !sessions_dir.is_dir() {
            return Ok(Vec::new());
        }

        let mut entries = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&sessions_dir).await?;
        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let session_id = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };
            if let Some(summary) = self.compute_summary(&session_id).await? {
                entries.push(summary);
            }
        }

        // Sort by modified_at descending (most recent first).
        entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        Ok(entries)
    }

    /// Get a summary of a specific session.
    pub async fn session_summary(
        &self,
        session_id: &str,
    ) -> anyhow::Result<Option<SessionSummary>> {
        self.compute_summary(session_id).await
    }

    /// Load session state from the transcript by replaying events to reconstruct
    /// the message history. Returns None if the session does not exist.
    pub async fn load_session_state(
        &self,
        session_id: &str,
    ) -> anyhow::Result<Option<SessionState>> {
        let transcript_path = self.session_dir(session_id).join("transcript.jsonl");
        if !transcript_path.is_file() {
            return Ok(None);
        }

        let content = tokio::fs::read_to_string(&transcript_path).await?;
        let mut messages: Vec<Message> = Vec::new();
        let mut cwd = PathBuf::new();
        let mut session_id_found = String::new();
        let mut first = true;

        for line in content.lines().filter(|l| !l.trim().is_empty()) {
            let envelope: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if first {
                first = false;
                if let Some(sid) = envelope.get("sessionId").and_then(|v| v.as_str()) {
                    session_id_found = sid.to_string();
                }
                if let Some(c) = envelope.get("cwd").and_then(|v| v.as_str()) {
                    cwd = PathBuf::from(c);
                }
            }

            let event_type = envelope
                .get("event")
                .and_then(|e| e.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            match event_type {
                "user.message" => {
                    if let Some(prompt) = envelope
                        .get("event")
                        .and_then(|e| e.get("prompt"))
                        .and_then(|v| v.as_str())
                    {
                        messages.push(user_message(prompt));
                    }
                }
                "turn.completed" => {
                    if let Some(response) = envelope
                        .get("event")
                        .and_then(|e| e.get("final_response"))
                        .and_then(|v| v.as_str())
                    {
                        if !response.is_empty() {
                            messages.push(assistant_message(response));
                        }
                    }
                }
                _ => {}
            }
        }

        if session_id_found.is_empty() {
            return Ok(None);
        }

        Ok(Some(SessionState {
            id: session_id_found,
            cwd,
            permission_mode: PermissionMode::Default,
            messages,
        }))
    }

    /// Find the most recently modified session.
    pub async fn latest_session(&self) -> anyhow::Result<Option<SessionSummary>> {
        let sessions = self.list_sessions().await?;
        Ok(sessions.into_iter().next())
    }

    /// Internal helper to compute a session summary from its transcript file.
    async fn compute_summary(&self, session_id: &str) -> anyhow::Result<Option<SessionSummary>> {
        let transcript_path = self.session_dir(session_id).join("transcript.jsonl");
        if !transcript_path.is_file() {
            return Ok(None);
        }

        let content = tokio::fs::read_to_string(&transcript_path).await?;
        let mut event_count: usize = 0;
        let mut turn_count: usize = 0;
        let mut created_at: Option<String> = None;
        let mut modified_at: Option<String> = None;
        let mut cwd: Option<PathBuf> = None;

        for line in content.lines().filter(|l| !l.trim().is_empty()) {
            let envelope: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            event_count += 1;

            if created_at.is_none() {
                created_at = envelope
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                cwd = envelope
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from);
            }

            modified_at = envelope
                .get("timestamp")
                .and_then(|v| v.as_str())
                .map(String::from);

            let event_type = envelope
                .get("event")
                .and_then(|e| e.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if event_type == "user.message" {
                turn_count += 1;
            }
        }

        if event_count == 0 {
            return Ok(None);
        }

        Ok(Some(SessionSummary {
            session_id: session_id.to_string(),
            created_at,
            modified_at,
            event_count,
            turn_count,
            cwd,
        }))
    }
}

fn event_turn_id(event: &RuntimeEvent) -> Option<&str> {
    match event {
        RuntimeEvent::TurnStarted { turn_id, .. }
        | RuntimeEvent::ProviderCompleted { turn_id, .. }
        | RuntimeEvent::ToolPermission { turn_id, .. }
        | RuntimeEvent::TurnCompleted { turn_id, .. }
        | RuntimeEvent::TurnFailed { turn_id, .. } => Some(turn_id.as_str()),
    }
}

fn timestamp_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.subsec_millis();
    let (year, month, day, hour, minute, second) = unix_seconds_to_utc(now.as_secs());
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn unix_seconds_to_utc(seconds: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    (year, month, day, hour, minute, second)
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
}

async fn append_jsonl<T: Serialize>(path: PathBuf, value: &T) -> anyhow::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    let mut line = serde_json::to_vec(value)?;
    line.push(b'\n');
    file.write_all(&line).await?;
    file.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PermissionMode, RuntimeEvent, assistant_message, user_message};
    use std::path::PathBuf;

    async fn create_test_session(
        root: &Path,
        session_id: &str,
        prompts_and_responses: &[(&str, &str)],
    ) {
        let store = TranscriptStore::new(root);
        let mut seq: u64 = 1;
        let mut last_uuid: Option<String> = None;

        for (prompt, response) in prompts_and_responses {
            let session = SessionState {
                id: session_id.to_string(),
                cwd: root.to_path_buf(),
                permission_mode: PermissionMode::Default,
                messages: vec![user_message(*prompt), assistant_message(*response)],
            };
            store.save_session(&session).await.unwrap();

            let envelope = store
                .append_event(
                    session_id,
                    root,
                    seq,
                    last_uuid.take(),
                    &RuntimeEvent::TurnStarted {
                        session_id: session_id.to_string(),
                        turn_id: format!("turn-{}", seq),
                        prompt: prompt.to_string(),
                    },
                )
                .await
                .unwrap();
            last_uuid = Some(envelope.uuid);
            seq += 1;

            let envelope = store
                .append_event(
                    session_id,
                    root,
                    seq,
                    last_uuid.take(),
                    &RuntimeEvent::TurnCompleted {
                        session_id: session_id.to_string(),
                        turn_id: format!("turn-{}", seq - 1),
                        final_response: response.to_string(),
                    },
                )
                .await
                .unwrap();
            last_uuid = Some(envelope.uuid);
            seq += 1;
        }
    }

    #[tokio::test]
    async fn list_sessions_returns_sorted_sessions() {
        let root =
            std::env::temp_dir().join(format!("tdcode-transcript-test-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(&root);

        // Create two sessions.
        create_test_session(&root, "session-alpha", &[("hello", "hi")]).await;
        // Small delay to ensure different timestamps.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        create_test_session(&root, "session-beta", &[("world", "yo"), ("again", "yes")]).await;

        let sessions = store.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 2);
        // Most recently modified first.
        assert_eq!(sessions[0].session_id, "session-beta");
        assert_eq!(sessions[1].session_id, "session-alpha");
    }

    #[tokio::test]
    async fn session_summary_counts_events_correctly() {
        let root =
            std::env::temp_dir().join(format!("tdcode-transcript-test-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(&root);

        create_test_session(&root, "session-count", &[("a", "b"), ("c", "d")]).await;

        let summary = store
            .session_summary("session-count")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(summary.session_id, "session-count");
        assert_eq!(summary.event_count, 4); // 2 events per turn * 2 turns
        assert_eq!(summary.turn_count, 2);
        assert!(summary.created_at.is_some());
        assert!(summary.modified_at.is_some());
        assert_eq!(summary.cwd, Some(root.clone()));
    }

    #[tokio::test]
    async fn session_summary_returns_none_for_nonexistent() {
        let root =
            std::env::temp_dir().join(format!("tdcode-transcript-test-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(&root);

        let result = store.session_summary("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn load_session_state_reconstructs_messages() {
        let root =
            std::env::temp_dir().join(format!("tdcode-transcript-test-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(&root);

        create_test_session(
            &root,
            "session-reconstruct",
            &[
                ("first prompt", "first response"),
                ("second prompt", "second response"),
            ],
        )
        .await;

        let state = store
            .load_session_state("session-reconstruct")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(state.id, "session-reconstruct");
        assert_eq!(state.cwd, root);
        // Messages should be: user, assistant, user, assistant
        assert_eq!(state.messages.len(), 4);
        assert_eq!(state.messages[0].role, "user");
        assert_eq!(state.messages[0].content, "first prompt");
        assert_eq!(state.messages[1].role, "assistant");
        assert_eq!(state.messages[1].content, "first response");
        assert_eq!(state.messages[2].role, "user");
        assert_eq!(state.messages[2].content, "second prompt");
        assert_eq!(state.messages[3].role, "assistant");
        assert_eq!(state.messages[3].content, "second response");
    }

    #[tokio::test]
    async fn load_session_state_returns_none_for_nonexistent() {
        let root =
            std::env::temp_dir().join(format!("tdcode-transcript-test-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(&root);

        let result = store.load_session_state("no-such-session").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn latest_session_returns_most_recent() {
        let root =
            std::env::temp_dir().join(format!("tdcode-transcript-test-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(&root);

        create_test_session(&root, "session-old", &[("old", "yes")]).await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        create_test_session(&root, "session-new", &[("new", "yes")]).await;

        let latest = store.latest_session().await.unwrap().unwrap();
        assert_eq!(latest.session_id, "session-new");
    }

    #[tokio::test]
    async fn latest_session_returns_none_when_empty() {
        let root =
            std::env::temp_dir().join(format!("tdcode-transcript-test-{}", uuid::Uuid::new_v4()));
        let store = TranscriptStore::new(&root);

        let result = store.latest_session().await.unwrap();
        assert!(result.is_none());
    }
}
