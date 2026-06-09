use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokendance_core::{MockProvider, PermissionMode, Runtime, StartThreadOptions, TurnResult};
use uuid::Uuid;

pub const SDK_CONTRACT_VERSION: &str = "agenthub-sdk.v1";
pub const AGENT_STREAM_SCHEMA_VERSION: u8 = 2;
pub const AGENTHUB_FRAME_SOURCE: &str = "tokendance-code-sdk";
pub const SESSION_RUN_IN_PROGRESS_CODE: &str = "AGENTHUB_SESSION_RUN_IN_PROGRESS";
pub const SESSION_RUN_IN_PROGRESS_REASON: &str = "same_session_run_in_progress";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHubRunOptions {
    pub prompt: String,
    pub working_directory: PathBuf,
    pub storage_root: PathBuf,
    pub task_id: String,
    pub edge_run_id: String,
    pub session_id: String,
    pub agent_instance_id: String,
    #[serde(default)]
    pub permission_mode: PermissionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHubFrame {
    pub schema_version: u8,
    pub sdk_contract_version: String,
    pub source: String,
    pub id: String,
    pub event_seq: u64,
    pub event_type: String,
    pub source_event_type: String,
    pub created_at: String,
    pub task_id: String,
    pub edge_run_id: String,
    pub session_id: String,
    pub agent_instance_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHubRunResult {
    pub turn: TurnResult,
    pub frames: Vec<AgentHubFrame>,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("AgentHub session {session_id} already has an active runner.run call.")]
pub struct AgentHubSessionRunInProgressError {
    pub code: &'static str,
    pub reason: &'static str,
    pub session_id: String,
    pub edge_run_id: String,
    pub active_edge_run_id: String,
    pub terminal_frame: AgentHubFrame,
}

#[derive(Debug, Default, Clone)]
pub struct AgentHubRunner {
    active: Arc<Mutex<HashMap<String, String>>>,
}

impl AgentHubRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn run(&self, options: AgentHubRunOptions) -> anyhow::Result<AgentHubRunResult> {
        let key = normalize_run_key(&options.storage_root, &options.session_id);
        {
            let mut active = self.active.lock().expect("active run map poisoned");
            if let Some(active_edge_run_id) = active.get(&key) {
                let terminal_frame =
                    same_session_rejected_frame(&options, active_edge_run_id.clone());
                return Err(AgentHubSessionRunInProgressError {
                    code: SESSION_RUN_IN_PROGRESS_CODE,
                    reason: SESSION_RUN_IN_PROGRESS_REASON,
                    session_id: options.session_id,
                    edge_run_id: options.edge_run_id,
                    active_edge_run_id: active_edge_run_id.clone(),
                    terminal_frame,
                }
                .into());
            }
            active.insert(key.clone(), options.edge_run_id.clone());
        }

        let result = self.run_inner(options).await;
        self.active
            .lock()
            .expect("active run map poisoned")
            .remove(&key);
        result
    }

    async fn run_inner(&self, options: AgentHubRunOptions) -> anyhow::Result<AgentHubRunResult> {
        let runtime = Runtime::new(MockProvider, options.storage_root.clone());
        let mut thread = runtime.start_thread(StartThreadOptions {
            working_directory: options.working_directory.clone(),
            storage_root: options.storage_root.clone(),
            permission_mode: options.permission_mode,
            session_id: Some(options.session_id.clone()),
        });
        let turn = thread.run(options.prompt.clone()).await?;
        let frames = turn
            .events
            .iter()
            .enumerate()
            .map(|(index, event)| runtime_event_frame(&options, event, (index + 1) as u64))
            .collect();
        Ok(AgentHubRunResult { turn, frames })
    }
}

fn runtime_event_frame(
    options: &AgentHubRunOptions,
    event: &tokendance_core::RuntimeEvent,
    event_seq: u64,
) -> AgentHubFrame {
    let source_event_type = source_event_type(event);
    let (event_type, payload) = match event {
        tokendance_core::RuntimeEvent::TurnCompleted { final_response, .. } => (
            "run.agent.result",
            json!({
                "success": true,
                "summary": final_response,
                "source_event": event,
            }),
        ),
        tokendance_core::RuntimeEvent::TurnFailed { error, .. } => (
            "run.agent.result",
            json!({
                "success": false,
                "summary": error,
                "error": error,
                "source_event": event,
            }),
        ),
        tokendance_core::RuntimeEvent::ToolPermission { .. } => (
            "run.agent.permission_requested",
            serde_json::to_value(event).unwrap_or(serde_json::Value::Null),
        ),
        _ => (
            "run.agent.log",
            serde_json::to_value(event).unwrap_or(serde_json::Value::Null),
        ),
    };
    build_frame(options, event_type, source_event_type, event_seq, payload)
}

fn same_session_rejected_frame(
    options: &AgentHubRunOptions,
    active_edge_run_id: String,
) -> AgentHubFrame {
    build_frame(
        options,
        "run.agent.result",
        "turn.failed",
        1,
        json!({
            "success": false,
            "summary": "AgentHub session already has an active runner.run call.",
            "error": "AgentHub session already has an active runner.run call.",
            "reason": SESSION_RUN_IN_PROGRESS_REASON,
            "code": SESSION_RUN_IN_PROGRESS_CODE,
            "active_edge_run_id": active_edge_run_id,
        }),
    )
}

fn build_frame(
    options: &AgentHubRunOptions,
    event_type: &str,
    source_event_type: &str,
    event_seq: u64,
    payload: serde_json::Value,
) -> AgentHubFrame {
    AgentHubFrame {
        schema_version: AGENT_STREAM_SCHEMA_VERSION,
        sdk_contract_version: SDK_CONTRACT_VERSION.to_string(),
        source: AGENTHUB_FRAME_SOURCE.to_string(),
        id: Uuid::new_v4().to_string(),
        event_seq,
        event_type: event_type.to_string(),
        source_event_type: source_event_type.to_string(),
        created_at: current_timestamp(),
        task_id: options.task_id.clone(),
        edge_run_id: options.edge_run_id.clone(),
        session_id: options.session_id.clone(),
        agent_instance_id: options.agent_instance_id.clone(),
        payload,
    }
}

fn source_event_type(event: &tokendance_core::RuntimeEvent) -> &'static str {
    match event {
        tokendance_core::RuntimeEvent::TurnStarted { .. } => "user.message",
        tokendance_core::RuntimeEvent::ProviderCompleted { .. } => "assistant.completed",
        tokendance_core::RuntimeEvent::ToolPermission { .. } => "tool.permission",
        tokendance_core::RuntimeEvent::TurnCompleted { .. } => "turn.completed",
        tokendance_core::RuntimeEvent::TurnFailed { .. } => "turn.failed",
    }
}

fn current_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn normalize_run_key(storage_root: &std::path::Path, session_id: &str) -> String {
    let resolved =
        std::fs::canonicalize(storage_root).unwrap_or_else(|_| storage_root.to_path_buf());
    let root = resolved.to_string_lossy();
    if cfg!(windows) {
        format!("{}\0{}", root.to_lowercase(), session_id)
    } else {
        format!("{root}\0{session_id}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use uuid::Uuid;

    fn run_options(root: PathBuf, edge_run_id: &str) -> AgentHubRunOptions {
        AgentHubRunOptions {
            prompt: "hello".to_string(),
            working_directory: root.clone(),
            storage_root: root,
            task_id: "task".to_string(),
            edge_run_id: edge_run_id.to_string(),
            session_id: "session".to_string(),
            agent_instance_id: "agent".to_string(),
            permission_mode: PermissionMode::Default,
        }
    }

    #[tokio::test]
    async fn runner_maps_runtime_events_to_agenthub_frames() {
        let root = std::env::temp_dir().join(format!("tdcode-rs-sdk-{}", Uuid::new_v4()));
        let runner = AgentHubRunner::new();
        let result = runner.run(run_options(root, "edge")).await.unwrap();
        assert_eq!(result.turn.thread_id, "session");

        for (index, frame) in result.frames.iter().enumerate() {
            assert_eq!(frame.schema_version, AGENT_STREAM_SCHEMA_VERSION);
            assert_eq!(frame.sdk_contract_version, SDK_CONTRACT_VERSION);
            assert_eq!(frame.source, AGENTHUB_FRAME_SOURCE);
            assert!(!frame.id.is_empty());
            assert_eq!(frame.event_seq, (index + 1) as u64);
            assert!(!frame.source_event_type.is_empty());
            assert!(!frame.created_at.is_empty());
        }

        let terminal = result
            .frames
            .iter()
            .find(|frame| frame.event_type == "run.agent.result")
            .expect("terminal result frame");
        assert_eq!(terminal.source_event_type, "turn.completed");
        assert_eq!(terminal.payload["success"], true);
        assert_eq!(terminal.payload["summary"], result.turn.final_response);
    }

    #[tokio::test]
    async fn same_session_rejection_exposes_failed_terminal_frame() {
        let root = std::env::temp_dir().join(format!("tdcode-rs-sdk-{}", Uuid::new_v4()));
        let runner = AgentHubRunner::new();
        let key = normalize_run_key(&root, "session");
        runner
            .active
            .lock()
            .expect("active run map poisoned")
            .insert(key, "active-edge".to_string());

        let error = runner
            .run(run_options(root, "rejected-edge"))
            .await
            .expect_err("same session run should be rejected");
        let error = error
            .downcast_ref::<AgentHubSessionRunInProgressError>()
            .expect("typed same-session rejection");

        assert_eq!(error.code, SESSION_RUN_IN_PROGRESS_CODE);
        assert_eq!(error.reason, SESSION_RUN_IN_PROGRESS_REASON);
        assert_eq!(error.terminal_frame.event_type, "run.agent.result");
        assert_eq!(error.terminal_frame.source_event_type, "turn.failed");
        assert_eq!(error.terminal_frame.edge_run_id, "rejected-edge");
        assert_eq!(error.terminal_frame.payload["success"], Value::Bool(false));
        assert_eq!(
            error.terminal_frame.payload["reason"],
            SESSION_RUN_IN_PROGRESS_REASON
        );
    }
}
