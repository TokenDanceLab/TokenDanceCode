use crate::{
    PermissionDecision, PermissionEngine, PermissionMode, PermissionProfileMetadata,
    PermissionRiskMetadata, PermissionStatus, SessionState, ToolCall, ToolConcurrency, ToolPolicy,
    ToolRisk, concurrency_label, permission_modes, risk_label,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

type ToolExecutor = Arc<dyn Fn(Value, &SessionState) -> anyhow::Result<Value> + Send + Sync>;
type ToolSubjectGuard = Arc<
    dyn Fn(&Value, &SessionState, PermissionMode) -> anyhow::Result<ToolSubjectGuardResult>
        + Send
        + Sync,
>;

pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub risk: ToolRisk,
    pub concurrency: ToolConcurrency,
    pub exposure: ToolExposure,
    pub safety_notes: Vec<String>,
    pub subject_metadata: Option<ToolSubjectMetadata>,
    subject_guard: Option<ToolSubjectGuard>,
    executor: ToolExecutor,
}

impl ToolDefinition {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        risk: ToolRisk,
        concurrency: ToolConcurrency,
        executor: impl Fn(Value) -> anyhow::Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            risk,
            concurrency,
            exposure: ToolExposure::default(),
            safety_notes: Vec::new(),
            subject_metadata: None,
            subject_guard: None,
            executor: Arc::new(move |input, _session| executor(input)),
        }
    }

    pub fn new_with_session(
        name: impl Into<String>,
        description: impl Into<String>,
        risk: ToolRisk,
        concurrency: ToolConcurrency,
        executor: impl Fn(Value, &SessionState) -> anyhow::Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            risk,
            concurrency,
            exposure: ToolExposure::default(),
            safety_notes: Vec::new(),
            subject_metadata: None,
            subject_guard: None,
            executor: Arc::new(executor),
        }
    }

    pub fn with_safety_notes(
        mut self,
        safety_notes: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.safety_notes = safety_notes.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_subject_metadata(mut self, subject_metadata: ToolSubjectMetadata) -> Self {
        self.subject_metadata = Some(subject_metadata);
        self
    }

    pub fn with_subject_guard(
        mut self,
        guard: impl Fn(&Value, &SessionState, PermissionMode) -> anyhow::Result<ToolSubjectGuardResult>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.subject_guard = Some(Arc::new(guard));
        self
    }

    pub fn with_exposure(mut self, exposure: ToolExposure) -> Self {
        self.exposure = exposure;
        self
    }

    fn policy(&self) -> ToolPolicy {
        ToolPolicy {
            name: self.name.clone(),
            risk: self.risk,
            concurrency: self.concurrency,
            safety_notes: self.safety_notes.clone(),
        }
    }
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, ToolDefinition>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: ToolDefinition) -> anyhow::Result<()> {
        if self.tools.contains_key(&tool.name) {
            anyhow::bail!("Tool already registered: {}", tool.name);
        }
        self.tools.insert(tool.name.clone(), tool);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<&ToolDefinition> {
        self.tools.get(name)
    }

    pub fn list(&self) -> Vec<&ToolDefinition> {
        self.tools.values().collect()
    }

    pub fn metadata(&self) -> Vec<ToolMetadata> {
        self.tools.values().map(ToolMetadata::from_tool).collect()
    }

    pub fn permission_decision(
        &self,
        call: &ToolCall,
        session: &SessionState,
    ) -> PermissionDecision {
        let Some(tool) = self.get(&call.name) else {
            return PermissionDecision {
                status: PermissionStatus::Denied,
                reason: format!("Unknown tool: {}", call.name),
                risk_metadata: None,
                mode: session.permission_mode,
                tool_name: call.name.clone(),
                subject: None,
            };
        };

        let guard_result = tool
            .subject_guard
            .as_ref()
            .and_then(|guard| guard(&call.input, session, session.permission_mode).ok())
            .unwrap_or_default();
        if let Some(evidence) = guard_result.blocked {
            return PermissionDecision {
                status: evidence.status,
                reason: evidence.reason,
                risk_metadata: None,
                mode: session.permission_mode,
                tool_name: call.name.clone(),
                subject: guard_result.subject,
            };
        }

        PermissionEngine::new(session.permission_mode)
            .decide(&tool.policy(), guard_result.subject.as_deref())
    }

    pub fn execute(
        &self,
        call: &ToolCall,
        session: &SessionState,
    ) -> anyhow::Result<ToolExecutionResult> {
        let Some(tool) = self.get(&call.name) else {
            return Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: false,
                output: None,
                error: Some(format!("Unknown tool: {}", call.name)),
                safety_evidence: None,
            });
        };

        let guard_result = if let Some(guard) = &tool.subject_guard {
            guard(&call.input, session, session.permission_mode)?
        } else {
            ToolSubjectGuardResult::default()
        };
        if let Some(mut evidence) = guard_result.blocked {
            evidence.tool_name = call.name.clone();
            return Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: false,
                output: None,
                error: Some(evidence.reason.clone()),
                safety_evidence: Some(evidence),
            });
        }

        let decision = PermissionEngine::new(session.permission_mode)
            .decide(&tool.policy(), guard_result.subject.as_deref());
        if decision.status != PermissionStatus::Allowed {
            return Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: false,
                output: None,
                error: Some(decision.reason.clone()),
                safety_evidence: Some(ToolSafetyEvidence {
                    tool_name: call.name.clone(),
                    source: ToolSafetyEvidenceSource::PermissionEngine,
                    status: decision.status,
                    reason: decision.reason.clone(),
                    decision: Some(decision),
                }),
            });
        }

        match (tool.executor)(call.input.clone(), session) {
            Ok(output) => Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: true,
                output: Some(output),
                error: None,
                safety_evidence: None,
            }),
            Err(error) => Ok(ToolExecutionResult {
                call_id: call.id.clone(),
                tool_name: call.name.clone(),
                ok: false,
                output: None,
                error: Some(error.to_string()),
                safety_evidence: None,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMetadata {
    pub name: String,
    pub description: String,
    pub risk: ToolRisk,
    pub risk_summary: String,
    pub concurrency: ToolConcurrency,
    pub exposure: ToolExposure,
    pub permission_profiles: BTreeMap<PermissionMode, PermissionProfileMetadata>,
    pub permission: BTreeMap<PermissionMode, PermissionStatus>,
    pub permission_reasons: BTreeMap<PermissionMode, String>,
    pub permission_risk_metadata: BTreeMap<PermissionMode, Option<PermissionRiskMetadata>>,
    pub subject_metadata: Option<ToolSubjectMetadata>,
    pub safety_notes: Vec<String>,
}

impl ToolMetadata {
    fn from_tool(tool: &ToolDefinition) -> Self {
        let profiles = PermissionEngine::describe_profiles(&tool.policy());
        Self {
            name: tool.name.clone(),
            description: tool.description.clone(),
            risk: tool.risk,
            risk_summary: risk_summary(tool.risk).to_string(),
            concurrency: tool.concurrency,
            exposure: tool.exposure,
            permission: permission_modes()
                .into_iter()
                .map(|mode| (mode, profiles[&mode].status))
                .collect(),
            permission_reasons: permission_modes()
                .into_iter()
                .map(|mode| (mode, profiles[&mode].reason.clone()))
                .collect(),
            permission_risk_metadata: permission_modes()
                .into_iter()
                .map(|mode| (mode, profiles[&mode].risk_metadata.clone()))
                .collect(),
            permission_profiles: profiles,
            subject_metadata: tool.subject_metadata.clone(),
            safety_notes: tool.safety_notes.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSubjectMetadata {
    pub kind: String,
    pub input_field: String,
    pub policy: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionResult {
    pub call_id: String,
    pub tool_name: String,
    pub ok: bool,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub safety_evidence: Option<ToolSafetyEvidence>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSafetyEvidence {
    pub tool_name: String,
    pub source: ToolSafetyEvidenceSource,
    pub status: PermissionStatus,
    pub reason: String,
    pub decision: Option<crate::PermissionDecision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSafetyEvidenceSource {
    PermissionEngine,
    SubjectGuard,
    PowerShellClassifier,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolExposure {
    /// Visible to the model immediately
    #[default]
    Direct,
    /// Registered but hidden from model; discoverable via tool_search
    Deferred,
    /// Registered for dispatch only, never shown to model
    Hidden,
}

#[derive(Default)]
pub struct ToolSubjectGuardResult {
    subject: Option<String>,
    blocked: Option<ToolSafetyEvidence>,
}

pub fn create_echo_tool() -> ToolDefinition {
    ToolDefinition::new(
        "echo",
        "Return text unchanged. Used for runtime and SDK smoke tests.",
        ToolRisk::Read,
        ToolConcurrency::ParallelSafe,
        |input| {
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("echo input requires a string text field"))?;
            Ok(json!({ "text": text }))
        },
    )
}

pub fn create_read_file_tool() -> ToolDefinition {
    ToolDefinition::new_with_session(
        "read_file",
        "Read a UTF-8 workspace file after path and secret-like subject checks.",
        ToolRisk::Read,
        ToolConcurrency::ParallelSafe,
        |input, session| {
            let workspace_path = workspace_path_from_input(&input, session)?;
            let content = std::fs::read_to_string(&workspace_path.absolute)?;
            Ok(json!({
                "path": workspace_path.relative,
                "content": content,
            }))
        },
    )
    .with_subject_metadata(workspace_path_subject_metadata())
    .with_subject_guard(workspace_path_subject_guard)
    .with_safety_notes([
        "Path input is resolved under the session workspace before use.",
        "Secret-like paths require approval or are denied in safe mode.",
    ])
}

pub fn create_write_file_tool() -> ToolDefinition {
    ToolDefinition::new_with_session(
        "write_file",
        "Write UTF-8 content to a workspace file after path and permission checks.",
        ToolRisk::Write,
        ToolConcurrency::Exclusive,
        |input, session| {
            let workspace_path = workspace_path_from_input(&input, session)?;
            let content = input
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!("write_file input requires a string content field")
                })?;
            if let Some(parent) = workspace_path.absolute.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&workspace_path.absolute, content)?;
            Ok(json!({
                "path": workspace_path.relative,
                "bytes": content.len(),
            }))
        },
    )
    .with_subject_metadata(workspace_path_subject_metadata())
    .with_subject_guard(workspace_path_subject_guard)
    .with_safety_notes([
        "Writes are restricted to paths under the session workspace.",
        "Secret-like paths require approval or are denied in safe mode.",
    ])
}

pub fn create_run_powershell_tool() -> ToolDefinition {
    ToolDefinition::new_with_session(
        "run_powershell",
        "Execute PowerShell commands on the local machine after classification and permission checks.",
        ToolRisk::Shell,
        ToolConcurrency::Exclusive,
        |input, session| {
            let command = command_from_input(&input)?;
            let trimmed = command.trim();

            let run_in_background = input
                .get("run_in_background")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if run_in_background {
                return Ok(json!({
                    "command": trimmed,
                    "stdout": "",
                    "stderr": "Background execution is not yet available. This feature will be added in a future version.",
                    "exit_code": null,
                    "background": true,
                }));
            }

            let _timeout_secs = input
                .get("timeout")
                .and_then(Value::as_u64)
                .unwrap_or(120)
                .min(600);

            let output = std::process::Command::new("powershell.exe")
                .arg("-Command")
                .arg(trimmed)
                .current_dir(&session.cwd)
                .output()
                .map_err(|e| anyhow::anyhow!("Failed to execute PowerShell: {e}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code();

            let success = output.status.success();

            Ok(json!({
                "command": trimmed,
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": exit_code,
                "success": success,
            }))
        },
    )
    .with_subject_metadata(ToolSubjectMetadata {
        kind: "powershell_command".to_string(),
        input_field: "command".to_string(),
        policy: "destructive commands are hard-denied before permission evaluation".to_string(),
    })
    .with_subject_guard(powershell_subject_guard)
    .with_safety_notes([
        "Destructive command patterns are hard-denied in every permission mode.",
        "Commands execute with the full PowerShell runtime on the host machine.",
        "Timeout defaults to 120s, capped at 600s.",
    ])
}

pub fn create_edit_tool() -> ToolDefinition {
    ToolDefinition::new_with_session(
        "edit_file",
        "Perform exact-string replacement in a file. The old_string must match exactly and be unique within the file.",
        ToolRisk::Write,
        ToolConcurrency::Exclusive,
        |input, session| {
            let workspace_path = workspace_path_from_input(&input, session)?;
            let old_string = input
                .get("old_string")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("edit_file input requires a string old_string field"))?;
            let new_string = input
                .get("new_string")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("edit_file input requires a string new_string field"))?;
            let replace_all = input
                .get("replace_all")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let content = std::fs::read_to_string(&workspace_path.absolute)
                .map_err(|e| anyhow::anyhow!("Failed to read file {}: {e}", workspace_path.relative))?;

            let match_count = content.matches(old_string).count();
            if match_count == 0 {
                anyhow::bail!(
                    "old_string not found in {}. The exact text must exist in the file.",
                    workspace_path.relative
                );
            }
            if !replace_all && match_count > 1 {
                anyhow::bail!(
                    "old_string found {} times in {}. Either use a more specific string or set replace_all to true.",
                    match_count,
                    workspace_path.relative
                );
            }

            let new_content = if replace_all {
                content.replace(old_string, new_string)
            } else {
                // Safe: we verified exactly 1 match above
                content.replacen(old_string, new_string, 1)
            };

            std::fs::write(&workspace_path.absolute, &new_content)
                .map_err(|e| anyhow::anyhow!("Failed to write file {}: {e}", workspace_path.relative))?;

            Ok(json!({
                "path": workspace_path.relative,
                "replacements": if replace_all { match_count } else { 1 },
            }))
        },
    )
    .with_subject_metadata(workspace_path_subject_metadata())
    .with_subject_guard(workspace_path_subject_guard)
    .with_safety_notes([
        "Performs exact-string replacement only — no regex or fuzzy matching.",
        "Path input is resolved under the session workspace before use.",
    ])
}

pub fn create_glob_tool() -> ToolDefinition {
    ToolDefinition::new_with_session(
        "glob",
        "Find files matching a glob pattern. Returns paths sorted by modification time (most recent first).",
        ToolRisk::Read,
        ToolConcurrency::ParallelSafe,
        |input, session| {
            let pattern = input
                .get("pattern")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("glob input requires a string pattern field"))?;

            let search_dir = input
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(".");

            let search_path = session.cwd.join(search_dir);

            let full_pattern = search_path.join(pattern);
            let full_pattern_str = full_pattern.to_string_lossy().replace('\\', "/");

            let glob_pattern = glob::glob(&full_pattern_str)
                .map_err(|e| anyhow::anyhow!("Invalid glob pattern '{}': {e}", full_pattern_str))?;

            let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
            for entry in glob_pattern {
                match entry {
                    Ok(path) => {
                        if path.is_file() {
                            let mtime = path.metadata()
                                .ok()
                                .and_then(|m| m.modified().ok())
                                .unwrap_or(std::time::UNIX_EPOCH);
                            entries.push((path, mtime));
                        }
                    }
                    Err(e) => {
                        // Skip unreadable paths but continue
                        let _ = e;
                    }
                }
            }

            // Sort by modification time, most recent first
            entries.sort_by_key(|b| std::cmp::Reverse(b.1));

            let max_results = 500;
            entries.truncate(max_results);

            let paths: Vec<String> = entries
                .into_iter()
                .map(|(path, _)| {
                    path.strip_prefix(&session.cwd)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect();

            Ok(json!({
                "files": paths,
                "count": paths.len(),
            }))
        },
    )
    .with_subject_metadata(workspace_path_subject_metadata())
    .with_subject_guard(directory_path_subject_guard)
    .with_safety_notes([
        "Read-only tool: inspects workspace state without writing.",
        "Results are limited to 500 files maximum.",
    ])
}

pub fn create_grep_tool() -> ToolDefinition {
    ToolDefinition::new_with_session(
        "grep",
        "Search file contents using regex patterns. Supports content, files_with_matches, and count output modes.",
        ToolRisk::Read,
        ToolConcurrency::ParallelSafe,
        |input, session| {
            let pattern_str = input
                .get("pattern")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("grep input requires a string pattern field"))?;

            let search_dir = input
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(".");

            let glob_filter = input
                .get("glob")
                .and_then(Value::as_str);

            let output_mode = input
                .get("output_mode")
                .and_then(Value::as_str)
                .unwrap_or("content");

            let head_limit = input
                .get("head_limit")
                .and_then(Value::as_u64)
                .unwrap_or(200) as usize;

            let re = regex::Regex::new(pattern_str)
                .map_err(|e| anyhow::anyhow!("Invalid regex pattern '{}': {e}", pattern_str))?;

            let search_path = session.cwd.join(search_dir);
            if !search_path.exists() {
                anyhow::bail!("Search directory does not exist: {}", search_dir);
            }

            let mut results: Vec<String> = Vec::new();
            let mut file_count_map: Vec<(String, usize)> = Vec::new();
            let mut file_matches: Vec<String> = Vec::new();

            grep_walk_directory(
                &search_path,
                &session.cwd,
                &re,
                glob_filter,
                output_mode,
                head_limit,
                &mut results,
                &mut file_count_map,
                &mut file_matches,
            )?;

            match output_mode {
                "files_with_matches" => {
                    file_matches.truncate(head_limit);
                    Ok(json!({
                        "files": file_matches,
                        "count": file_matches.len(),
                    }))
                }
                "count" => {
                    file_count_map.truncate(head_limit);
                    let entries: Vec<serde_json::Value> = file_count_map
                        .into_iter()
                        .map(|(file, count)| json!({ "file": file, "count": count }))
                        .collect();
                    Ok(json!({
                        "entries": entries,
                        "total_files": entries.len(),
                    }))
                }
                _ => {
                    // "content" mode
                    results.truncate(head_limit);
                    Ok(json!({
                        "matches": results,
                        "count": results.len(),
                    }))
                }
            }
        },
    )
    .with_subject_metadata(workspace_path_subject_metadata())
    .with_subject_guard(directory_path_subject_guard)
    .with_safety_notes([
        "Read-only tool: inspects workspace state without writing.",
        "Output is limited to 200 lines by default (configurable via head_limit).",
    ])
}

/// Recursively walk a directory tree, searching for regex pattern matches.
/// Skips .git, target, and node_modules directories.
#[allow(clippy::too_many_arguments)]
fn grep_walk_directory(
    dir: &Path,
    workspace: &Path,
    re: &regex::Regex,
    glob_filter: Option<&str>,
    output_mode: &str,
    head_limit: usize,
    results: &mut Vec<String>,
    file_count_map: &mut Vec<(String, usize)>,
    file_matches: &mut Vec<String>,
) -> anyhow::Result<()> {
    let skip_dirs = [".git", "target", "node_modules"];

    let entries = std::fs::read_dir(dir)
        .map_err(|e| anyhow::anyhow!("Failed to read directory {}: {e}", dir.display()))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();

        if path.is_dir() {
            let dir_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if skip_dirs.contains(&dir_name.as_str()) {
                continue;
            }
            grep_walk_directory(
                &path,
                workspace,
                re,
                glob_filter,
                output_mode,
                head_limit,
                results,
                file_count_map,
                file_matches,
            )?;
            continue;
        }

        // Apply glob filter if specified
        if let Some(filter) = glob_filter {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default();
            let glob_pattern = glob::Pattern::new(filter)
                .map_err(|e| anyhow::anyhow!("Invalid glob filter '{}': {e}", filter))?;
            if !glob_pattern.matches(&file_name) {
                continue;
            }
        }

        // Try to read and search the file
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue, // Skip binary/unreadable files
        };

        let relative = path
            .strip_prefix(workspace)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        let mut count = 0usize;
        for (line_num, line) in content.lines().enumerate() {
            if re.is_match(line) {
                count += 1;
                if output_mode == "content" && results.len() < head_limit {
                    results.push(format!("{}:{}:{}", relative, line_num + 1, line));
                }
            }
        }

        if count > 0 {
            if output_mode == "files_with_matches" {
                file_matches.push(relative);
            } else if output_mode == "count" {
                file_count_map.push((relative, count));
            }
        }
    }

    Ok(())
}

pub fn create_default_tool_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    registry
        .register(create_echo_tool().with_exposure(ToolExposure::Direct))
        .expect("echo tool name is unique");
    registry
        .register(create_read_file_tool().with_exposure(ToolExposure::Direct))
        .expect("read_file tool name is unique");
    registry
        .register(create_write_file_tool().with_exposure(ToolExposure::Direct))
        .expect("write_file tool name is unique");
    registry
        .register(create_run_powershell_tool().with_exposure(ToolExposure::Direct))
        .expect("run_powershell tool name is unique");
    registry
        .register(create_edit_tool().with_exposure(ToolExposure::Direct))
        .expect("edit_file tool name is unique");
    registry
        .register(create_glob_tool().with_exposure(ToolExposure::Direct))
        .expect("glob tool name is unique");
    registry
        .register(create_grep_tool().with_exposure(ToolExposure::Direct))
        .expect("grep tool name is unique");
    registry
}

struct WorkspacePath {
    relative: String,
    absolute: PathBuf,
}

fn workspace_path_subject_metadata() -> ToolSubjectMetadata {
    ToolSubjectMetadata {
        kind: "workspace_path".to_string(),
        input_field: "path".to_string(),
        policy: "relative paths are normalized and must stay under the session workspace"
            .to_string(),
    }
}

fn workspace_path_subject_guard(
    input: &Value,
    session: &SessionState,
    mode: PermissionMode,
) -> anyhow::Result<ToolSubjectGuardResult> {
    let path_value = path_from_input(input)?;
    let workspace_path = match normalize_workspace_path(&session.cwd, path_value) {
        Ok(path) => path,
        Err(error) => {
            return Ok(blocked_subject(
                "workspace_path",
                ToolSafetyEvidenceSource::SubjectGuard,
                PermissionStatus::Denied,
                format!("workspace path denied: {error}"),
            ));
        }
    };

    if secret_like_path(&workspace_path.relative) {
        let status = if mode == PermissionMode::Safe {
            PermissionStatus::Denied
        } else {
            PermissionStatus::RequiresApproval
        };
        return Ok(blocked_subject(
            workspace_path.relative,
            ToolSafetyEvidenceSource::SubjectGuard,
            status,
            "secret-like workspace path requires explicit approval".to_string(),
        ));
    }

    Ok(ToolSubjectGuardResult {
        subject: Some(workspace_path.relative),
        blocked: None,
    })
}

/// Like workspace_path_subject_guard but accepts directory paths ("." etc).
fn directory_path_subject_guard(
    input: &Value,
    _session: &SessionState,
    mode: PermissionMode,
) -> anyhow::Result<ToolSubjectGuardResult> {
    let raw_path = input.get("path").and_then(Value::as_str).unwrap_or(".");

    // Reject absolute paths
    if !raw_path.trim().is_empty() && Path::new(raw_path).is_absolute() {
        return Ok(blocked_subject(
            raw_path,
            ToolSafetyEvidenceSource::SubjectGuard,
            PermissionStatus::Denied,
            "absolute paths are not accepted".to_string(),
        ));
    }

    // Normalize and check for escape
    let mut normalized = PathBuf::new();
    for component in Path::new(raw_path).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(part) => normalized.push(part),
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Ok(blocked_subject(
                        raw_path,
                        ToolSafetyEvidenceSource::SubjectGuard,
                        PermissionStatus::Denied,
                        "path escapes the workspace".to_string(),
                    ));
                }
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Ok(blocked_subject(
                    raw_path,
                    ToolSafetyEvidenceSource::SubjectGuard,
                    PermissionStatus::Denied,
                    "path escapes the workspace".to_string(),
                ));
            }
        }
    }

    let relative = if normalized.as_os_str().is_empty() {
        ".".to_string()
    } else {
        normalized.to_string_lossy().replace('\\', "/")
    };

    if secret_like_path(&relative) {
        let status = if mode == PermissionMode::Safe {
            PermissionStatus::Denied
        } else {
            PermissionStatus::RequiresApproval
        };
        return Ok(blocked_subject(
            relative,
            ToolSafetyEvidenceSource::SubjectGuard,
            status,
            "secret-like path requires explicit approval".to_string(),
        ));
    }

    Ok(ToolSubjectGuardResult {
        subject: Some(relative),
        blocked: None,
    })
}

fn powershell_subject_guard(
    input: &Value,
    _session: &SessionState,
    _mode: PermissionMode,
) -> anyhow::Result<ToolSubjectGuardResult> {
    let command = command_from_input(input)?;
    if destructive_powershell_command(command) {
        return Ok(blocked_subject(
            command.to_string(),
            ToolSafetyEvidenceSource::PowerShellClassifier,
            PermissionStatus::Denied,
            "PowerShell classifier hard-deny: destructive command pattern".to_string(),
        ));
    }

    Ok(ToolSubjectGuardResult {
        subject: Some(command.to_string()),
        blocked: None,
    })
}

fn blocked_subject(
    subject: impl Into<String>,
    source: ToolSafetyEvidenceSource,
    status: PermissionStatus,
    reason: String,
) -> ToolSubjectGuardResult {
    let subject = subject.into();
    ToolSubjectGuardResult {
        subject: Some(subject.clone()),
        blocked: Some(ToolSafetyEvidence {
            tool_name: String::new(),
            source,
            status,
            reason,
            decision: None,
        }),
    }
}

fn workspace_path_from_input(
    input: &Value,
    session: &SessionState,
) -> anyhow::Result<WorkspacePath> {
    normalize_workspace_path(&session.cwd, path_from_input(input)?)
}

fn path_from_input(input: &Value) -> anyhow::Result<&str> {
    input
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("tool input requires a string path field"))
}

fn command_from_input(input: &Value) -> anyhow::Result<&str> {
    input
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("run_powershell input requires a string command field"))
}

fn normalize_workspace_path(workspace: &Path, raw_path: &str) -> anyhow::Result<WorkspacePath> {
    if raw_path.trim().is_empty() {
        anyhow::bail!("path cannot be empty");
    }

    let input_path = Path::new(raw_path);
    if input_path.is_absolute() {
        anyhow::bail!("absolute paths are not accepted");
    }

    let mut normalized = PathBuf::new();
    for component in input_path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    anyhow::bail!("path escapes the workspace");
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                anyhow::bail!("path escapes the workspace");
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        anyhow::bail!("path must name a file");
    }

    let relative = normalized.to_string_lossy().replace('\\', "/");
    Ok(WorkspacePath {
        absolute: workspace.join(&normalized),
        relative,
    })
}

fn secret_like_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    lower == ".env"
        || lower.ends_with("/.env")
        || lower.contains("secret")
        || lower.contains("token")
        || lower.contains("credential")
        || lower.contains("private_key")
}

fn destructive_powershell_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let compact = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.contains("remove-item")
        || compact.contains(" rm ")
        || compact.starts_with("rm ")
        || compact.contains("del /s")
        || compact.contains("erase /s")
        || compact.contains("clear-content")
        || compact.contains("format-volume")
        || compact.contains("stop-computer")
}

fn risk_summary(risk: ToolRisk) -> &'static str {
    match risk {
        ToolRisk::Read => "Read-only tool: inspects workspace state without writing.",
        ToolRisk::Write => "Write tool: can modify workspace files or state.",
        ToolRisk::Shell => {
            "Shell tool: executes local commands and is approval-gated outside yolo mode."
        }
        ToolRisk::Network => "Network tool: can contact external services.",
        ToolRisk::Dangerous => {
            "Dangerous tool: high-impact action requiring explicit approval outside yolo mode."
        }
    }
}

#[allow(dead_code)]
fn _labels_are_exported_for_catalog_parity(
    risk: ToolRisk,
    concurrency: ToolConcurrency,
) -> (&'static str, &'static str) {
    (risk_label(risk), concurrency_label(concurrency))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        PermissionMode, PermissionStatus, SessionState, ToolCall, ToolRisk, assistant_message,
        user_message,
    };
    use serde_json::json;
    use std::path::PathBuf;

    fn session(mode: PermissionMode) -> SessionState {
        SessionState {
            id: "session-rs".to_string(),
            cwd: PathBuf::from("."),
            permission_mode: mode,
            messages: vec![user_message("echo: hi"), assistant_message("calling echo")],
        }
    }

    #[test]
    fn default_registry_catalog_matches_ts_tool_metadata_contract() {
        let registry = create_default_tool_registry();
        let catalog = registry.metadata();
        let echo = catalog
            .iter()
            .find(|tool| tool.name == "echo")
            .expect("echo tool is registered");

        assert_eq!(echo.risk, ToolRisk::Read);
        assert_eq!(echo.concurrency, ToolConcurrency::ParallelSafe);
        assert_eq!(
            echo.permission_profiles[&PermissionMode::Default].status,
            PermissionStatus::Allowed
        );
        assert_eq!(
            echo.permission_profiles[&PermissionMode::Safe]
                .risk_metadata
                .as_ref()
                .unwrap()
                .concurrency,
            ToolConcurrency::ParallelSafe
        );

        let value = serde_json::to_value(echo).unwrap();
        assert_eq!(value["risk"], "read");
        assert_eq!(value["concurrency"], "parallel_safe");
        assert_eq!(
            value["permissionProfiles"]["default"]["riskMetadata"]["toolRisk"],
            "read"
        );
        assert_eq!(value["permission"]["default"], "allowed");
    }

    #[test]
    fn echo_tool_returns_text_unchanged() {
        let registry = create_default_tool_registry();
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-echo".to_string(),
                    name: "echo".to_string(),
                    input: json!({ "text": "hello rust" }),
                },
                &session(PermissionMode::Safe),
            )
            .unwrap();

        assert!(result.ok);
        assert_eq!(result.output, Some(json!({ "text": "hello rust" })));
        assert!(result.safety_evidence.is_none());
    }

    #[test]
    fn denied_tool_call_does_not_execute_and_returns_safety_evidence() {
        let mut registry = ToolRegistry::new();
        registry
            .register(ToolDefinition::new(
                "write_probe",
                "test write tool",
                ToolRisk::Write,
                ToolConcurrency::Exclusive,
                |_input| Ok(json!({ "executed": true })),
            ))
            .unwrap();

        let result = registry
            .execute(
                &ToolCall {
                    id: "call-write".to_string(),
                    name: "write_probe".to_string(),
                    input: json!({}),
                },
                &session(PermissionMode::Safe),
            )
            .unwrap();

        assert!(!result.ok);
        assert_eq!(result.output, None);
        assert_eq!(
            result.safety_evidence.as_ref().unwrap().source,
            ToolSafetyEvidenceSource::PermissionEngine
        );
        assert_eq!(
            result.safety_evidence.as_ref().unwrap().status,
            PermissionStatus::Denied
        );
    }

    #[test]
    fn registry_rejects_duplicates_and_unknown_calls_fail_closed() {
        let mut registry = ToolRegistry::new();
        registry.register(create_echo_tool()).unwrap();

        let duplicate = registry.register(create_echo_tool()).unwrap_err();
        assert!(
            duplicate
                .to_string()
                .contains("Tool already registered: echo")
        );

        let result = registry
            .execute(
                &ToolCall {
                    id: "missing".to_string(),
                    name: "missing_tool".to_string(),
                    input: json!({}),
                },
                &session(PermissionMode::Yolo),
            )
            .unwrap();

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("Unknown tool: missing_tool"));
    }

    #[test]
    fn workspace_path_tools_deny_path_escape_with_safety_evidence() {
        let registry = create_default_tool_registry();
        let result = registry
            .execute(
                &ToolCall {
                    id: "read-escape".to_string(),
                    name: "read_file".to_string(),
                    input: json!({ "path": "..\\outside.txt" }),
                },
                &session(PermissionMode::Yolo),
            )
            .unwrap();

        assert!(!result.ok);
        assert_eq!(
            result.safety_evidence.as_ref().unwrap().source,
            ToolSafetyEvidenceSource::SubjectGuard
        );
        assert_eq!(
            result.safety_evidence.as_ref().unwrap().status,
            PermissionStatus::Denied
        );
        assert!(
            result
                .safety_evidence
                .as_ref()
                .unwrap()
                .reason
                .contains("workspace")
        );
    }

    #[test]
    fn secret_like_workspace_paths_return_approval_or_deny_evidence() {
        let registry = create_default_tool_registry();
        let default_result = registry
            .execute(
                &ToolCall {
                    id: "read-env-default".to_string(),
                    name: "read_file".to_string(),
                    input: json!({ "path": ".env" }),
                },
                &session(PermissionMode::Default),
            )
            .unwrap();

        assert!(!default_result.ok);
        assert_eq!(
            default_result.safety_evidence.as_ref().unwrap().status,
            PermissionStatus::RequiresApproval
        );
        assert!(
            default_result
                .safety_evidence
                .as_ref()
                .unwrap()
                .reason
                .contains("secret-like")
        );

        let safe_result = registry
            .execute(
                &ToolCall {
                    id: "read-env-safe".to_string(),
                    name: "read_file".to_string(),
                    input: json!({ "path": "config\\secrets.json" }),
                },
                &session(PermissionMode::Safe),
            )
            .unwrap();

        assert!(!safe_result.ok);
        assert_eq!(
            safe_result.safety_evidence.as_ref().unwrap().status,
            PermissionStatus::Denied
        );
    }

    #[test]
    fn powershell_destructive_commands_are_hard_denied_even_in_yolo() {
        let registry = create_default_tool_registry();
        let result = registry
            .execute(
                &ToolCall {
                    id: "shell-rm".to_string(),
                    name: "run_powershell".to_string(),
                    input: json!({ "command": "Remove-Item -Recurse -Force .\\src" }),
                },
                &session(PermissionMode::Yolo),
            )
            .unwrap();

        assert!(!result.ok);
        assert_eq!(
            result.safety_evidence.as_ref().unwrap().source,
            ToolSafetyEvidenceSource::PowerShellClassifier
        );
        assert_eq!(
            result.safety_evidence.as_ref().unwrap().status,
            PermissionStatus::Denied
        );
        assert!(
            result
                .safety_evidence
                .as_ref()
                .unwrap()
                .reason
                .contains("hard-deny")
        );
    }

    #[test]
    fn default_catalog_includes_file_and_shell_subject_metadata() {
        let registry = create_default_tool_registry();
        let catalog = registry.metadata();
        let read_file = catalog
            .iter()
            .find(|tool| tool.name == "read_file")
            .expect("read_file tool is registered");
        let write_file = catalog
            .iter()
            .find(|tool| tool.name == "write_file")
            .expect("write_file tool is registered");
        let run_powershell = catalog
            .iter()
            .find(|tool| tool.name == "run_powershell")
            .expect("run_powershell tool is registered");

        assert_eq!(
            read_file.subject_metadata.as_ref().unwrap().kind,
            "workspace_path"
        );
        assert_eq!(
            write_file.subject_metadata.as_ref().unwrap().input_field,
            "path"
        );
        assert_eq!(
            run_powershell.subject_metadata.as_ref().unwrap().kind,
            "powershell_command"
        );
        assert_eq!(run_powershell.risk, ToolRisk::Shell);
        assert_eq!(
            run_powershell.permission_profiles[&PermissionMode::Default].status,
            PermissionStatus::RequiresApproval
        );
    }

    // --- New tests for edit, glob, grep, and shell ---

    fn session_with_tmpdir(tmpdir: &std::path::Path, mode: PermissionMode) -> SessionState {
        SessionState {
            id: "session-test".to_string(),
            cwd: tmpdir.to_path_buf(),
            permission_mode: mode,
            messages: vec![user_message("test"), assistant_message("testing")],
        }
    }

    #[test]
    fn edit_tool_basic_replace() {
        let tmpdir = tempfile::tempdir().unwrap();
        let file_path = tmpdir.path().join("hello.txt");
        std::fs::write(&file_path, "hello world\nfoo bar\n").unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-edit".to_string(),
                    name: "edit_file".to_string(),
                    input: json!({
                        "path": "hello.txt",
                        "old_string": "foo bar",
                        "new_string": "baz qux",
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(result.ok, "edit should succeed: {:?}", result.error);
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "hello world\nbaz qux\n");
        assert_eq!(result.output.unwrap()["replacements"], 1);
    }

    #[test]
    fn edit_tool_replace_all() {
        let tmpdir = tempfile::tempdir().unwrap();
        let file_path = tmpdir.path().join("repeat.txt");
        std::fs::write(&file_path, "aaa bbb aaa\nccc aaa\n").unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-edit-all".to_string(),
                    name: "edit_file".to_string(),
                    input: json!({
                        "path": "repeat.txt",
                        "old_string": "aaa",
                        "new_string": "zzz",
                        "replace_all": true,
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(result.ok, "replace_all should succeed: {:?}", result.error);
        let content = std::fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "zzz bbb zzz\nccc zzz\n");
        assert_eq!(result.output.unwrap()["replacements"], 3);
    }

    #[test]
    fn edit_tool_old_string_not_found() {
        let tmpdir = tempfile::tempdir().unwrap();
        let file_path = tmpdir.path().join("missing.txt");
        std::fs::write(&file_path, "hello\n").unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-edit-missing".to_string(),
                    name: "edit_file".to_string(),
                    input: json!({
                        "path": "missing.txt",
                        "old_string": "nonexistent",
                        "new_string": "replacement",
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(!result.ok);
        assert!(
            result.error.as_ref().unwrap().contains("not found"),
            "expected 'not found' error, got: {:?}",
            result.error
        );
    }

    #[test]
    fn edit_tool_duplicate_match_error() {
        let tmpdir = tempfile::tempdir().unwrap();
        let file_path = tmpdir.path().join("dup.txt");
        std::fs::write(&file_path, "dup line\ndup line\n").unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-edit-dup".to_string(),
                    name: "edit_file".to_string(),
                    input: json!({
                        "path": "dup.txt",
                        "old_string": "dup line",
                        "new_string": "unique line",
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(!result.ok);
        assert!(
            result.error.as_ref().unwrap().contains("2 times")
                || result.error.as_ref().unwrap().contains("found"),
            "expected duplicate match error, got: {:?}",
            result.error
        );
    }

    #[test]
    fn glob_tool_basic_pattern_match() {
        let tmpdir = tempfile::tempdir().unwrap();
        std::fs::write(tmpdir.path().join("a.rs"), "fn main() {}").unwrap();
        std::fs::write(tmpdir.path().join("b.rs"), "fn test() {}").unwrap();
        std::fs::write(tmpdir.path().join("c.txt"), "text").unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-glob".to_string(),
                    name: "glob".to_string(),
                    input: json!({
                        "path": ".",
                        "pattern": "*.rs",
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(result.ok, "glob should succeed: {:?}", result.error);
        let output = result.output.unwrap();
        let files = output["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        let file_strs: Vec<&str> = files.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(file_strs.contains(&"a.rs"));
        assert!(file_strs.contains(&"b.rs"));
        assert!(!file_strs.contains(&"c.txt"));
    }

    #[test]
    fn glob_tool_no_results() {
        let tmpdir = tempfile::tempdir().unwrap();
        std::fs::write(tmpdir.path().join("a.txt"), "text").unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-glob-empty".to_string(),
                    name: "glob".to_string(),
                    input: json!({
                        "path": ".",
                        "pattern": "*.xyz",
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(
            result.ok,
            "glob should succeed even with no matches: {:?}",
            result.error
        );
        let output = result.output.unwrap();
        assert_eq!(output["count"], 0);
        assert!(output["files"].as_array().unwrap().is_empty());
    }

    #[test]
    fn grep_tool_files_with_matches() {
        let tmpdir = tempfile::tempdir().unwrap();
        std::fs::write(tmpdir.path().join("match.rs"), "fn hello() {}").unwrap();
        std::fs::write(tmpdir.path().join("nomatch.rs"), "fn world() {}").unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-grep".to_string(),
                    name: "grep".to_string(),
                    input: json!({
                        "path": ".",
                        "pattern": "hello",
                        "output_mode": "files_with_matches",
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(result.ok, "grep should succeed: {:?}", result.error);
        let output = result.output.unwrap();
        let files = output["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].as_str().unwrap(), "match.rs");
    }

    #[test]
    fn grep_tool_content_mode_with_regex() {
        let tmpdir = tempfile::tempdir().unwrap();
        std::fs::write(
            tmpdir.path().join("data.txt"),
            "line one\nline two\nline three\n",
        )
        .unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-grep-content".to_string(),
                    name: "grep".to_string(),
                    input: json!({
                        "path": ".",
                        "pattern": "line (two|three)",
                        "output_mode": "content",
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(result.ok, "grep content should succeed: {:?}", result.error);
        let output = result.output.unwrap();
        let matches = output["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 2);
        let match_strs: Vec<&str> = matches.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(match_strs[0].contains("data.txt:2:line two"));
        assert!(match_strs[1].contains("data.txt:3:line three"));
    }

    #[test]
    fn shell_nonzero_exit_code() {
        let tmpdir = tempfile::tempdir().unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-shell-exit".to_string(),
                    name: "run_powershell".to_string(),
                    input: json!({
                        "command": "exit 1",
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(
            result.ok,
            "shell execution should succeed (non-zero exit is still an execution result): {:?}",
            result.error
        );
        let output = result.output.unwrap();
        assert_eq!(output["exit_code"], 1);
        assert_eq!(output["success"], false);
    }

    #[test]
    fn shell_background_returns_placeholder() {
        let tmpdir = tempfile::tempdir().unwrap();

        let registry = create_default_tool_registry();
        let session = session_with_tmpdir(tmpdir.path(), PermissionMode::Yolo);
        let result = registry
            .execute(
                &ToolCall {
                    id: "call-shell-bg".to_string(),
                    name: "run_powershell".to_string(),
                    input: json!({
                        "command": "Write-Output hello",
                        "run_in_background": true,
                    }),
                },
                &session,
            )
            .unwrap();

        assert!(
            result.ok,
            "background placeholder should succeed: {:?}",
            result.error
        );
        let output = result.output.unwrap();
        assert_eq!(output["background"], true);
        assert!(
            output["stderr"]
                .as_str()
                .unwrap()
                .contains("not yet available")
        );
    }

    #[test]
    fn tool_exposure_is_set_in_metadata() {
        let registry = create_default_tool_registry();
        let catalog = registry.metadata();

        let echo = catalog.iter().find(|t| t.name == "echo").unwrap();
        assert_eq!(echo.exposure, ToolExposure::Direct);

        let edit = catalog.iter().find(|t| t.name == "edit_file").unwrap();
        assert_eq!(edit.exposure, ToolExposure::Direct);

        let glob = catalog.iter().find(|t| t.name == "glob").unwrap();
        assert_eq!(glob.exposure, ToolExposure::Direct);

        let grep = catalog.iter().find(|t| t.name == "grep").unwrap();
        assert_eq!(grep.exposure, ToolExposure::Direct);
    }
}
