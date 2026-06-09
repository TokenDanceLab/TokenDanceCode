use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Represents a discovered instruction file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstructionFile {
    pub path: PathBuf,
    pub scope: InstructionScope,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InstructionScope {
    /// Global user-level (~/.tokendance/AGENTS.md)
    Global,
    /// Project-level (project_root/AGENTS.md or CLAUDE.md)
    Project,
    /// Local project-level (.tokendance/AGENTS.md)
    Local,
}

impl std::fmt::Display for InstructionScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstructionScope::Global => write!(f, "global"),
            InstructionScope::Project => write!(f, "project"),
            InstructionScope::Local => write!(f, "local"),
        }
    }
}

/// Context information about the current working environment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkingContext {
    pub project_root: PathBuf,
    /// Detected project type: "rust", "typescript", "mixed", "unknown"
    pub project_type: Option<String>,
    /// Top-level files and directories in the project root.
    pub top_level_files: Vec<String>,
    /// Number of instruction files discovered.
    pub instruction_count: usize,
}

/// Discover all instruction files for a project.
///
/// Search order (later overrides earlier):
/// 1. `~/.tokendance/AGENTS.md` (global)
/// 2. `{project_root}/AGENTS.md` (project)
/// 3. `{project_root}/CLAUDE.md` (project, alternative name)
/// 4. `{project_root}/.tokendance/AGENTS.md` (local)
pub async fn discover_instructions(project_root: &Path) -> Vec<InstructionFile> {
    let mut instructions = Vec::new();

    // 1. Global: ~/.tokendance/AGENTS.md
    if let Some(home) = home_dir() {
        let global_path = home.join(".tokendance").join("AGENTS.md");
        if let Some(content) = read_if_exists(&global_path).await {
            instructions.push(InstructionFile {
                path: global_path,
                scope: InstructionScope::Global,
                content,
            });
        }
    }

    // 2. Project root: AGENTS.md
    let project_agents = project_root.join("AGENTS.md");
    if let Some(content) = read_if_exists(&project_agents).await {
        instructions.push(InstructionFile {
            path: project_agents,
            scope: InstructionScope::Project,
            content,
        });
    }

    // 3. Project root: CLAUDE.md (alternative name)
    let project_claude = project_root.join("CLAUDE.md");
    if let Some(content) = read_if_exists(&project_claude).await {
        instructions.push(InstructionFile {
            path: project_claude,
            scope: InstructionScope::Project,
            content,
        });
    }

    // 4. Local: .tokendance/AGENTS.md
    let local_agents = project_root.join(".tokendance").join("AGENTS.md");
    if let Some(content) = read_if_exists(&local_agents).await {
        instructions.push(InstructionFile {
            path: local_agents,
            scope: InstructionScope::Local,
            content,
        });
    }

    instructions
}

/// Build the system prompt from discovered instructions.
///
/// Concatenates all instruction files with scope headers.
/// Order: Global, Project, Local (so later scopes override).
pub fn build_system_prompt(instructions: &[InstructionFile]) -> String {
    let mut parts = Vec::new();

    for instr in instructions {
        parts.push(format!(
            "--- {} instructions from {} ---\n{}\n",
            instr.scope,
            instr.path.display(),
            instr.content
        ));
    }

    parts.join("\n")
}

/// Build a context summary for the model.
///
/// Includes: working directory, discovered files, recent file list.
pub async fn build_working_context(project_root: &Path) -> WorkingContext {
    let instructions = discover_instructions(project_root).await;
    let instruction_count = instructions.len();

    let mut top_level_files = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(project_root).await {
        let mut names: Vec<String> = Vec::new();
        while let Ok(Some(entry)) = entries.next_entry().await {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
        names.sort();
        top_level_files = names;
    }

    let project_type = detect_project_type(&top_level_files, project_root).await;

    WorkingContext {
        project_root: project_root.to_path_buf(),
        project_type,
        top_level_files,
        instruction_count,
    }
}

async fn detect_project_type(files: &[String], project_root: &Path) -> Option<String> {
    let has_cargo = files.iter().any(|f| f == "Cargo.toml");
    let has_package_json = files.iter().any(|f| f == "package.json");
    let has_tsconfig = files.iter().any(|f| f == "tsconfig.json");

    // Check for Cargo workspace members or src/ dir
    let _has_rust_src = project_root.join("src").is_dir() || project_root.join("crates").is_dir();

    match (has_cargo, has_package_json || has_tsconfig) {
        (true, true) => Some("mixed".to_string()),
        (true, false) => Some("rust".to_string()),
        (false, true) => Some("typescript".to_string()),
        (false, false) => None,
    }
}

async fn read_if_exists(path: &Path) -> Option<String> {
    if path.is_file() {
        tokio::fs::read_to_string(path).await.ok()
    } else {
        None
    }
}

fn home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        return Some(PathBuf::from(home));
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        return Some(PathBuf::from(userprofile));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio::fs;

    async fn create_temp_project(structure: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, content) in structure {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await.unwrap();
            }
            fs::write(&path, content).await.unwrap();
        }
        dir
    }

    #[tokio::test]
    async fn discover_instructions_finds_agents_md_in_project_root() {
        let dir = create_temp_project(&[("AGENTS.md", "project instructions")]).await;

        let instructions = discover_instructions(dir.path()).await;

        assert_eq!(instructions.len(), 1);
        assert_eq!(instructions[0].scope, InstructionScope::Project);
        assert_eq!(instructions[0].content, "project instructions");
        assert!(instructions[0].path.ends_with("AGENTS.md"));
    }

    #[tokio::test]
    async fn discover_instructions_finds_both_agents_and_claude_md() {
        let dir = create_temp_project(&[
            ("AGENTS.md", "agents instructions"),
            ("CLAUDE.md", "claude instructions"),
        ])
        .await;

        let instructions = discover_instructions(dir.path()).await;

        let project_instructions: Vec<_> = instructions
            .iter()
            .filter(|i| i.scope == InstructionScope::Project)
            .collect();
        assert_eq!(project_instructions.len(), 2);

        let contents: Vec<&str> = project_instructions
            .iter()
            .map(|i| i.content.as_str())
            .collect();
        assert!(contents.contains(&"agents instructions"));
        assert!(contents.contains(&"claude instructions"));
    }

    #[tokio::test]
    async fn discover_instructions_finds_local_agents_md() {
        let dir = create_temp_project(&[(".tokendance/AGENTS.md", "local instructions")]).await;

        let instructions = discover_instructions(dir.path()).await;

        assert_eq!(instructions.len(), 1);
        assert_eq!(instructions[0].scope, InstructionScope::Local);
        assert_eq!(instructions[0].content, "local instructions");
    }

    #[tokio::test]
    async fn discover_instructions_returns_empty_when_no_files() {
        let dir = tempfile::tempdir().unwrap();

        let instructions = discover_instructions(dir.path()).await;

        // Only returns project-local files (no global since HOME/.tokendance/AGENTS.md likely doesn't exist in test)
        let non_global: Vec<_> = instructions
            .iter()
            .filter(|i| i.scope != InstructionScope::Global)
            .collect();
        assert!(non_global.is_empty());
    }

    #[tokio::test]
    async fn build_system_prompt_formats_correctly() {
        let instructions = vec![
            InstructionFile {
                path: PathBuf::from("/home/user/.tokendance/AGENTS.md"),
                scope: InstructionScope::Global,
                content: "global rules".to_string(),
            },
            InstructionFile {
                path: PathBuf::from("/project/AGENTS.md"),
                scope: InstructionScope::Project,
                content: "project rules".to_string(),
            },
            InstructionFile {
                path: PathBuf::from("/project/.tokendance/AGENTS.md"),
                scope: InstructionScope::Local,
                content: "local rules".to_string(),
            },
        ];

        let prompt = build_system_prompt(&instructions);

        assert!(prompt.contains("--- global instructions from"));
        assert!(prompt.contains("global rules"));
        assert!(prompt.contains("--- project instructions from"));
        assert!(prompt.contains("project rules"));
        assert!(prompt.contains("--- local instructions from"));
        assert!(prompt.contains("local rules"));
    }

    #[tokio::test]
    async fn build_system_prompt_empty_instructions() {
        let prompt = build_system_prompt(&[]);
        assert!(prompt.is_empty());
    }

    #[tokio::test]
    async fn build_working_context_detects_rust_project() {
        let dir = create_temp_project(&[("Cargo.toml", "[package]\nname = \"test\"")]).await;

        let ctx = build_working_context(dir.path()).await;

        assert_eq!(ctx.project_type.as_deref(), Some("rust"));
        assert!(ctx.top_level_files.contains(&"Cargo.toml".to_string()));
    }

    #[tokio::test]
    async fn build_working_context_detects_typescript_project() {
        let dir = create_temp_project(&[("package.json", "{}"), ("tsconfig.json", "{}")]).await;

        let ctx = build_working_context(dir.path()).await;

        assert_eq!(ctx.project_type.as_deref(), Some("typescript"));
    }

    #[tokio::test]
    async fn build_working_context_detects_mixed_project() {
        let dir = create_temp_project(&[
            ("Cargo.toml", "[package]\nname = \"test\""),
            ("package.json", "{}"),
        ])
        .await;

        let ctx = build_working_context(dir.path()).await;

        assert_eq!(ctx.project_type.as_deref(), Some("mixed"));
    }

    #[tokio::test]
    async fn build_working_context_unknown_project_type() {
        let dir = create_temp_project(&[("README.md", "hello")]).await;

        let ctx = build_working_context(dir.path()).await;

        assert!(ctx.project_type.is_none());
    }

    #[tokio::test]
    async fn build_working_context_counts_instruction_files() {
        let dir = create_temp_project(&[
            ("Cargo.toml", "[package]\nname = \"test\""),
            ("AGENTS.md", "project instructions"),
        ])
        .await;

        let ctx = build_working_context(dir.path()).await;

        // At least 1 (the project AGENTS.md), possibly more if global exists
        assert!(ctx.instruction_count >= 1);
    }

    #[tokio::test]
    async fn instruction_scope_display() {
        assert_eq!(InstructionScope::Global.to_string(), "global");
        assert_eq!(InstructionScope::Project.to_string(), "project");
        assert_eq!(InstructionScope::Local.to_string(), "local");
    }
}
