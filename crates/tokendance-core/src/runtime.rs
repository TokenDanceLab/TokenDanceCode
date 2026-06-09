use crate::{
    ModelProvider, PermissionMode, ProviderRequest, RuntimeEvent, SessionState, ToolRegistry,
    ToolResult, TranscriptStore, TurnResult, assistant_message, create_default_tool_registry,
    user_message,
};
use std::path::PathBuf;
use uuid::Uuid;

const MAX_MODEL_CALLS_PER_TURN: usize = 2;

pub struct Runtime<P> {
    provider: P,
    tools: ToolRegistry,
    store: TranscriptStore,
}

#[derive(Debug, Clone)]
pub struct StartThreadOptions {
    pub working_directory: PathBuf,
    pub storage_root: PathBuf,
    pub permission_mode: PermissionMode,
    pub session_id: Option<String>,
}

impl<P: ModelProvider> Runtime<P> {
    pub fn new(provider: P, storage_root: impl Into<PathBuf>) -> Self {
        Self {
            provider,
            tools: create_default_tool_registry(),
            store: TranscriptStore::new(storage_root),
        }
    }

    pub fn with_tool_registry(
        provider: P,
        storage_root: impl Into<PathBuf>,
        tools: ToolRegistry,
    ) -> Self {
        Self {
            provider,
            tools,
            store: TranscriptStore::new(storage_root),
        }
    }

    pub fn start_thread(&self, options: StartThreadOptions) -> Thread<'_, P> {
        let session_id = options
            .session_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let position = self.store.resume_position(&session_id);
        let session = SessionState {
            id: session_id,
            cwd: options.working_directory,
            permission_mode: options.permission_mode,
            messages: Vec::new(),
        };
        Thread {
            provider: &self.provider,
            tools: &self.tools,
            store: self.store.clone(),
            session,
            next_seq: position.next_seq,
            last_uuid: position.last_uuid,
        }
    }
}

pub struct Thread<'a, P> {
    provider: &'a P,
    tools: &'a ToolRegistry,
    store: TranscriptStore,
    session: SessionState,
    next_seq: u64,
    last_uuid: Option<String>,
}

impl<P: ModelProvider> Thread<'_, P> {
    pub async fn run(&mut self, prompt: impl Into<String>) -> anyhow::Result<TurnResult> {
        let prompt = prompt.into();
        let turn_id = Uuid::new_v4().to_string();
        let mut events = Vec::new();
        self.session.messages.push(user_message(prompt.clone()));
        self.store.save_session(&self.session).await?;

        self.emit(
            RuntimeEvent::TurnStarted {
                session_id: self.session.id.clone(),
                turn_id: turn_id.clone(),
                prompt,
            },
            &mut events,
        )
        .await?;

        let mut tool_results = Vec::new();
        let final_response = loop {
            let model_call_number = if tool_results.is_empty() { 1 } else { 2 };
            let response = self
                .provider
                .create_turn(ProviderRequest {
                    session: self.session.clone(),
                    tool_results,
                })
                .await;

            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    self.emit_turn_failed(&turn_id, error.to_string(), &mut events)
                        .await?;
                    return Err(error);
                }
            };

            self.emit(
                RuntimeEvent::ProviderCompleted {
                    session_id: self.session.id.clone(),
                    turn_id: turn_id.clone(),
                    assistant_message: response.assistant_message.clone(),
                    tool_call_count: response.tool_calls.len(),
                },
                &mut events,
            )
            .await?;

            if response.tool_calls.is_empty() {
                break response.assistant_message.unwrap_or_default();
            }

            if model_call_number >= MAX_MODEL_CALLS_PER_TURN {
                let error = anyhow::anyhow!(
                    "model call limit exceeded while processing tool calls; max={}",
                    MAX_MODEL_CALLS_PER_TURN
                );
                self.emit_turn_failed(&turn_id, error.to_string(), &mut events)
                    .await?;
                return Err(error);
            }

            tool_results = Vec::with_capacity(response.tool_calls.len());
            for call in response.tool_calls {
                let decision = self.tools.permission_decision(&call, &self.session);
                self.emit(
                    RuntimeEvent::ToolPermission {
                        session_id: self.session.id.clone(),
                        turn_id: turn_id.clone(),
                        call: call.clone(),
                        decision,
                    },
                    &mut events,
                )
                .await?;

                let result = self.tools.execute(&call, &self.session)?;
                tool_results.push(ToolResult {
                    call_id: result.call_id,
                    tool_name: result.tool_name,
                    ok: result.ok,
                    output: result.output,
                    error: result.error,
                });
            }
        };

        self.session
            .messages
            .push(assistant_message(final_response.clone()));
        self.store.save_session(&self.session).await?;
        self.emit(
            RuntimeEvent::TurnCompleted {
                session_id: self.session.id.clone(),
                turn_id: turn_id.clone(),
                final_response: final_response.clone(),
            },
            &mut events,
        )
        .await?;

        Ok(TurnResult {
            thread_id: self.session.id.clone(),
            turn_id,
            final_response,
            events,
        })
    }

    pub fn state(&self) -> &SessionState {
        &self.session
    }

    async fn emit_turn_failed(
        &mut self,
        turn_id: &str,
        error: String,
        events: &mut Vec<RuntimeEvent>,
    ) -> anyhow::Result<()> {
        self.emit(
            RuntimeEvent::TurnFailed {
                session_id: self.session.id.clone(),
                turn_id: turn_id.to_string(),
                error,
            },
            events,
        )
        .await
    }

    async fn emit(
        &mut self,
        event: RuntimeEvent,
        events: &mut Vec<RuntimeEvent>,
    ) -> anyhow::Result<()> {
        self.store
            .append_event(
                &self.session.id,
                &self.session.cwd,
                self.next_seq,
                self.last_uuid.take(),
                &event,
            )
            .await
            .map(|envelope| {
                self.last_uuid = Some(envelope.uuid);
            })?;
        self.next_seq += 1;
        events.push(event);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        MockProvider, ProviderResponse, ToolCall, ToolConcurrency, ToolDefinition, ToolRegistry,
        ToolResult, ToolRisk, TranscriptEnvelope,
    };
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tokio::fs;

    #[tokio::test]
    async fn run_writes_session_and_transcript() {
        let root = std::env::temp_dir().join(format!("tdcode-rs-test-{}", Uuid::new_v4()));
        let runtime = Runtime::new(MockProvider, root.clone());
        let mut thread = runtime.start_thread(StartThreadOptions {
            working_directory: root.clone(),
            storage_root: root.clone(),
            permission_mode: PermissionMode::Default,
            session_id: Some("session-rs".to_string()),
        });
        let result = thread.run("hello").await.unwrap();
        assert_eq!(result.thread_id, "session-rs");
        assert!(result.final_response.contains("hello"));
        assert!(
            root.join("sessions")
                .join("session-rs")
                .join("transcript.jsonl")
                .exists()
        );
    }

    #[tokio::test]
    async fn transcript_envelopes_include_session_metadata_and_parent_chain() {
        let root = std::env::temp_dir().join(format!("tdcode-rs-test-{}", Uuid::new_v4()));
        let runtime = Runtime::new(MockProvider, root.clone());
        let mut thread = runtime.start_thread(StartThreadOptions {
            working_directory: root.clone(),
            storage_root: root.clone(),
            permission_mode: PermissionMode::Default,
            session_id: Some("session-envelope".to_string()),
        });

        thread.run("hello").await.unwrap();

        let envelopes = read_transcript(&root, "session-envelope").await;
        assert_eq!(envelopes.len(), 3);
        assert_eq!(envelopes[0].seq, 1);
        assert_eq!(envelopes[0].session_id, "session-envelope");
        assert_eq!(envelopes[0].turn_id, envelopes[1].turn_id);
        assert_eq!(envelopes[0].cwd, root);
        assert!(!envelopes[0].uuid.is_empty());
        assert!(envelopes[0].timestamp.contains('T'));
        assert!(envelopes[0].parent_uuid.is_none());
        assert_eq!(
            envelopes[1].parent_uuid.as_deref(),
            Some(envelopes[0].uuid.as_str())
        );
        assert_eq!(
            envelopes[2].parent_uuid.as_deref(),
            Some(envelopes[1].uuid.as_str())
        );
    }

    #[tokio::test]
    async fn start_thread_continues_transcript_sequence_for_existing_session() {
        let root = std::env::temp_dir().join(format!("tdcode-rs-test-{}", Uuid::new_v4()));
        let options = StartThreadOptions {
            working_directory: root.clone(),
            storage_root: root.clone(),
            permission_mode: PermissionMode::Default,
            session_id: Some("session-resume".to_string()),
        };

        let runtime = Runtime::new(MockProvider, root.clone());
        let mut first = runtime.start_thread(options.clone());
        first.run("first").await.unwrap();

        let mut second = runtime.start_thread(options);
        second.run("second").await.unwrap();

        let envelopes = read_transcript(&root, "session-resume").await;
        let seqs = envelopes
            .iter()
            .map(|envelope| envelope.seq)
            .collect::<Vec<_>>();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(
            envelopes[3].parent_uuid.as_deref(),
            Some(envelopes[2].uuid.as_str())
        );
    }

    #[tokio::test]
    async fn run_executes_provider_tool_calls_and_sends_results_to_followup_model_call() {
        let root = std::env::temp_dir().join(format!("tdcode-rs-test-{}", Uuid::new_v4()));
        let provider = ToolLoopProvider::new(vec![
            ProviderResponse {
                assistant_message: None,
                tool_calls: vec![ToolCall {
                    id: "call-add".to_string(),
                    name: "add_one".to_string(),
                    input: json!({ "value": 41 }),
                }],
            },
            ProviderResponse {
                assistant_message: Some("tool said 42".to_string()),
                tool_calls: Vec::new(),
            },
        ]);
        let calls = provider.requests.clone();
        let runtime = Runtime::with_tool_registry(provider, root.clone(), add_one_registry());
        let mut thread = runtime.start_thread(StartThreadOptions {
            working_directory: root.clone(),
            storage_root: root.clone(),
            permission_mode: PermissionMode::Safe,
            session_id: Some("session-tools".to_string()),
        });

        let result = thread.run("calculate").await.unwrap();

        assert_eq!(result.final_response, "tool said 42");
        let requests = calls.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].tool_results.is_empty());
        assert_eq!(
            requests[1].tool_results,
            vec![ToolResult {
                call_id: "call-add".to_string(),
                tool_name: "add_one".to_string(),
                ok: true,
                output: Some(json!({ "value": 42 })),
                error: None,
            }]
        );
        assert!(result.events.iter().any(|event| matches!(
            event,
            RuntimeEvent::ToolPermission { decision, .. }
                if decision.tool_name == "add_one" && decision.status == crate::PermissionStatus::Allowed
        )));
    }

    #[tokio::test]
    async fn run_fails_when_provider_exceeds_model_call_limit_with_more_tool_calls() {
        let root = std::env::temp_dir().join(format!("tdcode-rs-test-{}", Uuid::new_v4()));
        let provider = ToolLoopProvider::new(vec![
            ProviderResponse {
                assistant_message: None,
                tool_calls: vec![ToolCall {
                    id: "call-add-1".to_string(),
                    name: "add_one".to_string(),
                    input: json!({ "value": 1 }),
                }],
            },
            ProviderResponse {
                assistant_message: None,
                tool_calls: vec![ToolCall {
                    id: "call-add-2".to_string(),
                    name: "add_one".to_string(),
                    input: json!({ "value": 2 }),
                }],
            },
        ]);
        let calls = provider.requests.clone();
        let runtime = Runtime::with_tool_registry(provider, root.clone(), add_one_registry());
        let mut thread = runtime.start_thread(StartThreadOptions {
            working_directory: root.clone(),
            storage_root: root.clone(),
            permission_mode: PermissionMode::Safe,
            session_id: Some("session-tool-limit".to_string()),
        });

        let error = thread.run("loop").await.unwrap_err();

        assert!(error.to_string().contains("model call limit"));
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    async fn read_transcript(root: &std::path::Path, session_id: &str) -> Vec<TranscriptEnvelope> {
        let content = fs::read_to_string(
            root.join("sessions")
                .join(session_id)
                .join("transcript.jsonl"),
        )
        .await
        .unwrap();

        content
            .lines()
            .map(|line| serde_json::from_str::<TranscriptEnvelope>(line).unwrap())
            .collect()
    }

    fn add_one_registry() -> ToolRegistry {
        let mut registry = ToolRegistry::new();
        registry
            .register(ToolDefinition::new(
                "add_one",
                "increment a test value",
                ToolRisk::Read,
                ToolConcurrency::Serial,
                |input| {
                    let value = input
                        .get("value")
                        .and_then(serde_json::Value::as_i64)
                        .ok_or_else(|| anyhow::anyhow!("value must be an integer"))?;
                    Ok(json!({ "value": value + 1 }))
                },
            ))
            .unwrap();
        registry
    }

    struct ToolLoopProvider {
        responses: Mutex<Vec<ProviderResponse>>,
        requests: Arc<Mutex<Vec<ProviderRequest>>>,
    }

    impl ToolLoopProvider {
        fn new(responses: Vec<ProviderResponse>) -> Self {
            Self {
                responses: Mutex::new(responses.into_iter().rev().collect()),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    #[async_trait]
    impl ModelProvider for ToolLoopProvider {
        fn protocol(&self) -> Option<crate::ProviderProtocol> {
            None
        }

        async fn create_turn(&self, request: ProviderRequest) -> anyhow::Result<ProviderResponse> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop()
                .ok_or_else(|| anyhow::anyhow!("unexpected provider call"))
        }
    }
}
