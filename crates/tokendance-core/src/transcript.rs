use crate::{RuntimeEvent, SessionState};
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

        let mut last_seq = 0;
        let mut last_uuid = None;
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if let Some(seq) = value.get("seq").and_then(serde_json::Value::as_u64) {
                last_seq = seq;
            } else {
                last_seq += 1;
            }
            if let Some(uuid) = value.get("uuid").and_then(serde_json::Value::as_str) {
                last_uuid = Some(uuid.to_string());
            }
        }

        TranscriptPosition {
            next_seq: last_seq + 1,
            last_uuid,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
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
    Ok(())
}
