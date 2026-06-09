use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
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
pub const TOKENDANCE_ID_OIDC_SCHEMA_VERSION: u8 = 1;
pub const OIDC_PKCE_S256_METHOD: &str = "S256";
pub const AGENTHUB_APPROVAL_SCHEMA_VERSION: u8 = 1;
pub const AGENTHUB_APPROVAL_PENDING_EVENT: &str = "approval.pending";
pub const AGENTHUB_APPROVAL_DECIDED_EVENT: &str = "approval.decided";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenDanceIdOidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenDanceIdOidcLoginRequest {
    pub schema_version: u8,
    pub issuer: String,
    pub authorization_url: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    pub state: String,
    pub code_verifier: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
}

impl TokenDanceIdOidcLoginRequest {
    pub fn new(config: TokenDanceIdOidcConfig) -> Result<Self, TokenDanceIdOidcError> {
        Self::from_parts(config, random_pkce_value(), random_pkce_value())
    }

    pub fn from_parts(
        config: TokenDanceIdOidcConfig,
        state: String,
        code_verifier: String,
    ) -> Result<Self, TokenDanceIdOidcError> {
        validate_non_empty("issuer", &config.issuer)?;
        validate_non_empty("client_id", &config.client_id)?;
        validate_non_empty("redirect_uri", &config.redirect_uri)?;
        validate_non_empty("state", &state)?;
        validate_pkce_verifier(&code_verifier)?;

        let code_challenge = pkce_s256_challenge(&code_verifier);
        let authorization_url = oidc_authorization_url(&config, &state, &code_challenge)?;
        Ok(Self {
            schema_version: TOKENDANCE_ID_OIDC_SCHEMA_VERSION,
            issuer: config.issuer,
            authorization_url,
            client_id: config.client_id,
            redirect_uri: config.redirect_uri,
            scopes: config.scopes,
            state,
            code_verifier,
            code_challenge,
            code_challenge_method: OIDC_PKCE_S256_METHOD.to_string(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenDanceIdOidcCallback {
    pub state: String,
    pub code: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatedTokenDanceIdOidcCallback {
    pub state: String,
    pub code: String,
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum TokenDanceIdOidcError {
    #[error("OIDC {field} must not be empty.")]
    EmptyField { field: &'static str },
    #[error("OIDC PKCE verifier must be 43 to 128 characters.")]
    InvalidPkceVerifierLength,
    #[error("OIDC PKCE verifier contains an unsupported character.")]
    InvalidPkceVerifierCharacter,
    #[error("OIDC issuer or redirect URI is not a valid URL.")]
    InvalidUrl,
    #[error("OIDC callback state does not match the pending login request.")]
    StateMismatch,
    #[error("OIDC callback returned an authorization error: {0}")]
    CallbackError(String),
    #[error("OIDC callback did not include an authorization code.")]
    MissingCode,
}

pub fn validate_tokendance_id_callback_state(
    expected_state: &str,
    callback: TokenDanceIdOidcCallback,
) -> Result<ValidatedTokenDanceIdOidcCallback, TokenDanceIdOidcError> {
    if expected_state != callback.state {
        return Err(TokenDanceIdOidcError::StateMismatch);
    }
    if let Some(error) = callback.error {
        return Err(TokenDanceIdOidcError::CallbackError(error));
    }
    let code = callback.code.ok_or(TokenDanceIdOidcError::MissingCode)?;
    Ok(ValidatedTokenDanceIdOidcCallback {
        state: callback.state,
        code,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentHubApprovalRequest {
    pub approval_id: String,
    pub task_id: String,
    pub edge_run_id: String,
    pub session_id: String,
    pub agent_instance_id: String,
    pub reason: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentHubApprovalStatus {
    Pending,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentHubApprovalDecisionKind {
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentHubApprovalDecision {
    pub decision: AgentHubApprovalDecisionKind,
    pub decided_by: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentHubApprovalSnapshot {
    pub schema_version: u8,
    pub sdk_contract_version: String,
    pub source: String,
    pub event_type: String,
    pub approval_id: String,
    pub task_id: String,
    pub edge_run_id: String,
    pub session_id: String,
    pub agent_instance_id: String,
    pub status: AgentHubApprovalStatus,
    pub reason: String,
    pub requested_at: String,
    pub decided_at: Option<String>,
    pub decided_by: Option<String>,
    pub decision_comment: Option<String>,
    pub payload: serde_json::Value,
}

impl AgentHubApprovalSnapshot {
    pub fn pending(request: AgentHubApprovalRequest) -> Self {
        Self {
            schema_version: AGENTHUB_APPROVAL_SCHEMA_VERSION,
            sdk_contract_version: SDK_CONTRACT_VERSION.to_string(),
            source: AGENTHUB_FRAME_SOURCE.to_string(),
            event_type: AGENTHUB_APPROVAL_PENDING_EVENT.to_string(),
            approval_id: request.approval_id,
            task_id: request.task_id,
            edge_run_id: request.edge_run_id,
            session_id: request.session_id,
            agent_instance_id: request.agent_instance_id,
            status: AgentHubApprovalStatus::Pending,
            reason: request.reason,
            requested_at: current_timestamp(),
            decided_at: None,
            decided_by: None,
            decision_comment: None,
            payload: request.payload,
        }
    }

    pub fn decide(
        &self,
        decision: AgentHubApprovalDecision,
    ) -> Result<Self, AgentHubApprovalError> {
        if self.status != AgentHubApprovalStatus::Pending {
            return Err(AgentHubApprovalError::AlreadyDecided);
        }
        let mut snapshot = self.clone();
        snapshot.event_type = AGENTHUB_APPROVAL_DECIDED_EVENT.to_string();
        snapshot.status = match decision.decision {
            AgentHubApprovalDecisionKind::Approved => AgentHubApprovalStatus::Approved,
            AgentHubApprovalDecisionKind::Rejected => AgentHubApprovalStatus::Rejected,
        };
        snapshot.decided_at = Some(current_timestamp());
        snapshot.decided_by = Some(decision.decided_by);
        snapshot.decision_comment = decision.comment;
        Ok(snapshot)
    }
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum AgentHubApprovalError {
    #[error("AgentHub approval snapshot has already been decided.")]
    AlreadyDecided,
}

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

fn random_pkce_value() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn validate_non_empty(field: &'static str, value: &str) -> Result<(), TokenDanceIdOidcError> {
    if value.trim().is_empty() {
        Err(TokenDanceIdOidcError::EmptyField { field })
    } else {
        Ok(())
    }
}

fn validate_pkce_verifier(verifier: &str) -> Result<(), TokenDanceIdOidcError> {
    if !(43..=128).contains(&verifier.len()) {
        return Err(TokenDanceIdOidcError::InvalidPkceVerifierLength);
    }
    if !verifier
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~'))
    {
        return Err(TokenDanceIdOidcError::InvalidPkceVerifierCharacter);
    }
    Ok(())
}

fn pkce_s256_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn oidc_authorization_url(
    config: &TokenDanceIdOidcConfig,
    state: &str,
    code_challenge: &str,
) -> Result<String, TokenDanceIdOidcError> {
    validate_urlish(&config.issuer)?;
    validate_urlish(&config.redirect_uri)?;
    let scope = config.scopes.join(" ");
    let pairs = [
        ("response_type", "code"),
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", config.redirect_uri.as_str()),
        ("scope", scope.as_str()),
        ("state", state),
        ("code_challenge", code_challenge),
        ("code_challenge_method", OIDC_PKCE_S256_METHOD),
    ];
    let query = pairs
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    Ok(format!(
        "{}/oauth/authorize?{}",
        config.issuer.trim_end_matches('/'),
        query
    ))
}

fn validate_urlish(value: &str) -> Result<(), TokenDanceIdOidcError> {
    if value.starts_with("https://") || value.starts_with("http://") {
        Ok(())
    } else {
        Err(TokenDanceIdOidcError::InvalidUrl)
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else if byte == b' ' {
            encoded.push('+');
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
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

    #[test]
    fn oidc_login_request_builds_pkce_s256_authorization_url_without_token_exchange() {
        let request = TokenDanceIdOidcLoginRequest::from_parts(
            TokenDanceIdOidcConfig {
                issuer: "https://id.tokendance.example".to_string(),
                client_id: "agenthub-desktop".to_string(),
                redirect_uri: "http://127.0.0.1:49200/callback".to_string(),
                scopes: vec!["openid".to_string(), "profile".to_string()],
            },
            "state-123".to_string(),
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_string(),
        )
        .expect("valid login request");

        assert_eq!(request.schema_version, TOKENDANCE_ID_OIDC_SCHEMA_VERSION);
        assert_eq!(request.code_challenge_method, OIDC_PKCE_S256_METHOD);
        assert_eq!(
            request.code_challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(
            request.code_verifier,
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        );
        assert!(request.authorization_url.contains("/oauth/authorize?"));
        assert!(request.authorization_url.contains("response_type=code"));
        assert!(
            request
                .authorization_url
                .contains("client_id=agenthub-desktop")
        );
        assert!(request.authorization_url.contains("scope=openid+profile"));
        assert!(!request.authorization_url.contains("access_token"));
        assert!(!request.authorization_url.contains("refresh_token"));
        assert!(!request.authorization_url.contains("id_token"));
    }

    #[test]
    fn oidc_callback_validation_accepts_matching_state_and_rejects_mismatch() {
        let callback = TokenDanceIdOidcCallback {
            state: "expected-state".to_string(),
            code: Some("authorization-code".to_string()),
            error: None,
        };

        let validated =
            validate_tokendance_id_callback_state("expected-state", callback.clone()).unwrap();
        assert_eq!(validated.code, "authorization-code");
        assert_eq!(validated.state, "expected-state");

        let error = validate_tokendance_id_callback_state("other-state", callback)
            .expect_err("state mismatch should be rejected");
        assert_eq!(error, TokenDanceIdOidcError::StateMismatch);
    }

    #[test]
    fn approval_bridge_snapshots_pending_then_decide_without_mutating_pending_snapshot() {
        let pending = AgentHubApprovalSnapshot::pending(AgentHubApprovalRequest {
            approval_id: "approval-1".to_string(),
            task_id: "task".to_string(),
            edge_run_id: "edge".to_string(),
            session_id: "session".to_string(),
            agent_instance_id: "agent".to_string(),
            reason: "tool permission".to_string(),
            payload: json!({"tool": "shell"}),
        });

        assert_eq!(pending.schema_version, AGENTHUB_APPROVAL_SCHEMA_VERSION);
        assert_eq!(pending.status, AgentHubApprovalStatus::Pending);
        assert_eq!(pending.event_type, AGENTHUB_APPROVAL_PENDING_EVENT);
        assert_eq!(pending.payload["tool"], "shell");

        let decided = pending
            .decide(AgentHubApprovalDecision {
                decision: AgentHubApprovalDecisionKind::Approved,
                decided_by: "operator".to_string(),
                comment: Some("allow once".to_string()),
            })
            .expect("pending approval can be decided");

        assert_eq!(pending.status, AgentHubApprovalStatus::Pending);
        assert_eq!(pending.event_type, AGENTHUB_APPROVAL_PENDING_EVENT);
        assert_eq!(decided.status, AgentHubApprovalStatus::Approved);
        assert_eq!(decided.event_type, AGENTHUB_APPROVAL_DECIDED_EVENT);
        assert_eq!(decided.decided_by.as_deref(), Some("operator"));
        assert_eq!(decided.decision_comment.as_deref(), Some("allow once"));
    }
}
