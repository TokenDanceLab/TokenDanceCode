use clap::{Parser, Subcommand};
use serde::Serialize;
use tokendance_core::{
    MockProvider, PermissionMode, ProviderConfig, Runtime, RuntimeEvent, StartThreadOptions,
    TurnResult, doctor_info,
};

#[derive(Debug, Parser)]
#[command(name = "tokendance")]
#[command(version)]
#[command(about = "TokenDanceCode Rust CLI")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Run {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    Doctor {
        #[arg(long)]
        json: bool,
    },
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    Gateway {
        #[command(subcommand)]
        command: GatewayCommand,
    },
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    Sessions,
    Transcript {
        #[command(subcommand)]
        command: TranscriptCommand,
    },
    Quality {
        command: Vec<String>,
    },
}

#[derive(Debug, Subcommand)]
enum ConfigCommand {
    Validate {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum GatewayCommand {
    Init {
        #[arg(long)]
        model: String,
    },
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    Tokendanceid {
        #[command(subcommand)]
        command: TokenDanceIdCommand,
    },
}

#[derive(Debug, Subcommand)]
enum TokenDanceIdCommand {
    LoginUrl {
        #[arg(long)]
        client_id: String,
        #[arg(long)]
        redirect_uri: String,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum TranscriptCommand {
    Search { query: String },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Doctor { json: false }) {
        Command::Run { args } => {
            let parsed = parse_run_args(args)?;
            run_command(parsed.prompt, parsed.format).await?
        }
        Command::Doctor { json } => doctor_command(json)?,
        Command::Config {
            command: ConfigCommand::Validate { json },
        } => config_validate(json)?,
        Command::Gateway {
            command: GatewayCommand::Init { model },
        } => println!(
            "TokenDance Gateway preset ready for model {model}. Set TOKENDANCE_GATEWAY_API_KEY in a controlled environment."
        ),
        Command::Auth {
            command:
                AuthCommand::Tokendanceid {
                    command:
                        TokenDanceIdCommand::LoginUrl {
                            client_id,
                            redirect_uri,
                            json,
                        },
                },
        } => login_url(client_id, redirect_uri, json)?,
        Command::Sessions => println!("sessions: Rust session listing is scaffolded."),
        Command::Transcript {
            command: TranscriptCommand::Search { query },
        } => println!("transcript search scaffold: {query}"),
        Command::Quality { command } => println!("quality scaffold: {}", command.join(" ")),
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunOutputFormat {
    Text,
    Json,
    StreamJson,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunArgs {
    prompt: String,
    format: RunOutputFormat,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StructuredRunResult {
    schema_version: u8,
    command: &'static str,
    thread_id: String,
    session_id: String,
    success: bool,
    final_response: String,
    events: Vec<StructuredRunEvent>,
    error: Option<StructuredRunError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StructuredRunEvent {
    schema_version: u8,
    command: &'static str,
    thread_id: String,
    event_type: String,
    #[serde(flatten)]
    event: RuntimeEvent,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StructuredRunTerminalEvent {
    schema_version: u8,
    command: &'static str,
    thread_id: String,
    session_id: String,
    event_type: &'static str,
    success: bool,
    final_response: String,
    error: Option<StructuredRunError>,
}

#[derive(Debug, Clone, Serialize)]
struct StructuredRunError {
    name: String,
    message: String,
}

fn parse_run_args(args: Vec<String>) -> anyhow::Result<RunArgs> {
    let mut format = RunOutputFormat::Text;
    let mut prompt_args = Vec::new();
    let mut index = 0;

    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            prompt_args.extend(args[index + 1..].iter().cloned());
            break;
        }
        if arg == "--json" || arg == "--stream-json" {
            let next_format = if arg == "--json" {
                RunOutputFormat::Json
            } else {
                RunOutputFormat::StreamJson
            };
            if format != RunOutputFormat::Text && format != next_format {
                anyhow::bail!("Usage: tokendance run [--json|--stream-json] <prompt>");
            }
            format = next_format;
            index += 1;
            continue;
        }
        prompt_args.extend(args[index..].iter().cloned());
        break;
    }

    Ok(RunArgs {
        prompt: prompt_args.join(" ").trim().to_string(),
        format,
    })
}

async fn run_command(prompt: String, format: RunOutputFormat) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let storage = cwd.join(".tokendance-rs");
    let runtime = Runtime::new(MockProvider, storage.clone());
    let mut thread = runtime.start_thread(StartThreadOptions {
        working_directory: cwd,
        storage_root: storage,
        permission_mode: PermissionMode::Default,
        session_id: None,
    });
    let result = thread.run(prompt).await?;
    match format {
        RunOutputFormat::StreamJson => write_stream_json_result(result)?,
        RunOutputFormat::Json => {
            println!("{}", serde_json::to_string(&structured_run_result(result))?);
        }
        RunOutputFormat::Text => println!("{}", result.final_response),
    }
    Ok(())
}

fn structured_run_result(result: TurnResult) -> StructuredRunResult {
    let events = result
        .events
        .into_iter()
        .map(|event| StructuredRunEvent {
            schema_version: 1,
            command: "run",
            thread_id: result.thread_id.clone(),
            event_type: event_type(&event).to_string(),
            event,
        })
        .collect();

    StructuredRunResult {
        schema_version: 1,
        command: "run",
        thread_id: result.thread_id.clone(),
        session_id: result.thread_id,
        success: true,
        final_response: result.final_response,
        events,
        error: None,
    }
}

fn write_stream_json_result(result: TurnResult) -> anyhow::Result<()> {
    let structured = structured_run_result(result);
    for event in &structured.events {
        println!("{}", serde_json::to_string(event)?);
    }
    println!(
        "{}",
        serde_json::to_string(&StructuredRunTerminalEvent {
            schema_version: structured.schema_version,
            command: structured.command,
            thread_id: structured.thread_id,
            session_id: structured.session_id,
            event_type: "run.result",
            success: structured.success,
            final_response: structured.final_response,
            error: structured.error,
        })?
    );
    Ok(())
}

fn event_type(event: &RuntimeEvent) -> &'static str {
    match event {
        RuntimeEvent::TurnStarted { .. } => "turn.started",
        RuntimeEvent::ProviderCompleted { .. } => "provider.completed",
        RuntimeEvent::ToolPermission { .. } => "tool.permission",
        RuntimeEvent::TurnCompleted { .. } => "turn.completed",
        RuntimeEvent::TurnFailed { .. } => "turn.failed",
    }
}

fn doctor_command(json: bool) -> anyhow::Result<()> {
    let info = doctor_info(env!("CARGO_PKG_VERSION"), ProviderConfig::default());
    if json {
        println!("{}", serde_json::to_string_pretty(&info)?);
    } else {
        println!("TokenDanceCode Rust {}", info.version);
        println!("provider: {:?}", info.provider.kind);
    }
    Ok(())
}

fn config_validate(json: bool) -> anyhow::Result<()> {
    let value = serde_json::json!({
        "valid": true,
        "provider": ProviderConfig::default(),
        "loads_project_env": false
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!("config ok");
    }
    Ok(())
}

fn login_url(client_id: String, redirect_uri: String, json: bool) -> anyhow::Result<()> {
    let url = format!(
        "https://id.tokendance.example/oauth/authorize?response_type=code&client_id={client_id}&redirect_uri={redirect_uri}&code_challenge_method=S256"
    );
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "url": url,
                "clientId": client_id,
                "redirectUri": redirect_uri,
                "exchangeOwner": "AgentHub Hub Server",
                "storesTokenDanceIdTokens": false
            }))?
        );
    } else {
        println!("{url}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tokendance_core::RuntimeEvent;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn run_parser_counts_only_leading_structured_flags() {
        let parsed = parse_run_args(args(&["explain", "--json", "flag"])).unwrap();

        assert_eq!(parsed.format, RunOutputFormat::Text);
        assert_eq!(parsed.prompt, "explain --json flag");
    }

    #[test]
    fn run_parser_accepts_leading_json_and_stream_flags() {
        let json = parse_run_args(args(&["--json", "hello"])).unwrap();
        let stream = parse_run_args(args(&["--stream-json", "hello"])).unwrap();

        assert_eq!(json.format, RunOutputFormat::Json);
        assert_eq!(json.prompt, "hello");
        assert_eq!(stream.format, RunOutputFormat::StreamJson);
        assert_eq!(stream.prompt, "hello");
    }

    #[test]
    fn run_parser_uses_double_dash_for_literal_leading_flags() {
        let parsed = parse_run_args(args(&["--", "--json", "literal"])).unwrap();

        assert_eq!(parsed.format, RunOutputFormat::Text);
        assert_eq!(parsed.prompt, "--json literal");
    }

    #[test]
    fn run_parser_rejects_conflicting_leading_structured_flags() {
        let error = parse_run_args(args(&["--json", "--stream-json", "hello"])).unwrap_err();

        assert_eq!(
            error.to_string(),
            "Usage: tokendance run [--json|--stream-json] <prompt>"
        );
    }

    #[test]
    fn structured_run_json_matches_contract_baseline() {
        let result = structured_run_result(TurnResult {
            thread_id: "session-rs".to_string(),
            turn_id: "turn-rs".to_string(),
            final_response: "mock response: hello".to_string(),
            events: vec![
                RuntimeEvent::TurnStarted {
                    session_id: "session-rs".to_string(),
                    turn_id: "turn-rs".to_string(),
                    prompt: "hello".to_string(),
                },
                RuntimeEvent::TurnCompleted {
                    session_id: "session-rs".to_string(),
                    turn_id: "turn-rs".to_string(),
                    final_response: "mock response: hello".to_string(),
                },
            ],
        });
        let value: Value = serde_json::to_value(result).unwrap();

        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["command"], "run");
        assert_eq!(value["threadId"], "session-rs");
        assert_eq!(value["sessionId"], "session-rs");
        assert_eq!(value["success"], true);
        assert_eq!(value["finalResponse"], "mock response: hello");
        assert_eq!(value["error"], Value::Null);
        assert_eq!(value["events"][0]["eventType"], "turn.started");
        assert_eq!(value["events"][0]["type"], "user.message");
        assert_eq!(value["events"][1]["eventType"], "turn.completed");
    }

    #[test]
    fn stream_terminal_event_matches_contract_baseline() {
        let event = StructuredRunTerminalEvent {
            schema_version: 1,
            command: "run",
            thread_id: "session-rs".to_string(),
            session_id: "session-rs".to_string(),
            event_type: "run.result",
            success: true,
            final_response: "mock response: hello".to_string(),
            error: None,
        };
        let value: Value = serde_json::to_value(event).unwrap();

        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["command"], "run");
        assert_eq!(value["threadId"], "session-rs");
        assert_eq!(value["sessionId"], "session-rs");
        assert_eq!(value["eventType"], "run.result");
        assert_eq!(value["success"], true);
        assert_eq!(value["finalResponse"], "mock response: hello");
        assert_eq!(value["error"], Value::Null);
    }

    #[test]
    fn doctor_json_contract_baseline_is_serializable() {
        let info = doctor_info("0.3.0-rs.0", ProviderConfig::default());
        let value: Value = serde_json::to_value(info).unwrap();

        assert_eq!(value["version"], "0.3.0-rs.0");
        assert_eq!(value["rust_runtime"], true);
        assert_eq!(value["provider"]["kind"], "mock");
        assert_eq!(value["provider"]["model"], "mock");
        assert!(value["warnings"].as_array().unwrap().is_empty());
    }
}
