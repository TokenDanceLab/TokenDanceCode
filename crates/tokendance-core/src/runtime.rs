use crate::{
    ModelProvider, PermissionEngine, PermissionMode, ProviderRequest, RuntimeEvent, SessionState,
    TranscriptStore, TurnResult, assistant_message, user_message,
};
use std::path::PathBuf;
use uuid::Uuid;

pub struct Runtime<P> {
    provider: P,
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
            store: self.store.clone(),
            session,
            next_seq: position.next_seq,
            last_uuid: position.last_uuid,
        }
    }
}

pub struct Thread<'a, P> {
    provider: &'a P,
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

        let response = self
            .provider
            .create_turn(ProviderRequest {
                session: self.session.clone(),
                tool_results: Vec::new(),
            })
            .await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.emit(
                    RuntimeEvent::TurnFailed {
                        session_id: self.session.id.clone(),
                        turn_id: turn_id.clone(),
                        error: error.to_string(),
                    },
                    &mut events,
                )
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

        let _permission_engine = PermissionEngine::new(self.session.permission_mode);
        let final_response = response.assistant_message.unwrap_or_default();
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
    use crate::{MockProvider, TranscriptEnvelope};
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
}
