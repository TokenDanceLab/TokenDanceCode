use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A single memory entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub name: String,
    pub description: String,
    pub content: String,
    pub metadata: MemoryMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryMetadata {
    #[serde(rename = "type")]
    pub entry_type: MemoryType,
    pub updated: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemoryType {
    User,
    Feedback,
    Project,
    Reference,
}

/// Memory store backed by a directory of markdown files.
///
/// Each memory entry is stored as a `.md` file with YAML-like frontmatter:
///
/// ```markdown
/// ---
/// name: user-preferences
/// description: User's coding preferences
/// metadata:
///   type: feedback
/// ---
///
/// User prefers kebab-case for directory names...
/// ```
pub struct MemoryStore {
    root: PathBuf,
}

impl MemoryStore {
    /// Create a memory store at the given root.
    ///
    /// Root is typically `~/.tokendance/projects/{project-hash}/memory/`.
    /// The directory is created lazily on first write.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Returns the root directory of this store.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// List all memory entries.
    pub async fn list(&self) -> Result<Vec<MemoryEntry>> {
        if !self.root.is_dir() {
            return Ok(Vec::new());
        }

        let mut entries = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&self.root)
            .await
            .with_context(|| format!("failed to read memory directory: {}", self.root.display()))?;

        while let Some(entry) = read_dir.next_entry().await.with_context(|| {
            format!(
                "failed to read entry in memory directory: {}",
                self.root.display()
            )
        })? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(memory_entry) = self.parse_memory_file(&path).await? {
                    entries.push(memory_entry);
                }
            }
        }

        // Sort by name for deterministic ordering.
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    /// Read a specific memory entry by name.
    pub async fn read(&self, name: &str) -> Result<Option<MemoryEntry>> {
        let path = self.entry_path(name)?;
        if !path.is_file() {
            return Ok(None);
        }
        self.parse_memory_file(&path).await
    }

    /// Write a memory entry. Creates or updates.
    pub async fn write(&self, entry: &MemoryEntry) -> Result<()> {
        let path = self.entry_path(&entry.name)?;

        // Ensure the root directory exists.
        tokio::fs::create_dir_all(&self.root)
            .await
            .with_context(|| {
                format!("failed to create memory directory: {}", self.root.display())
            })?;

        let content = serialize_entry(entry);
        tokio::fs::write(&path, content)
            .await
            .with_context(|| format!("failed to write memory file: {}", path.display()))?;

        Ok(())
    }

    /// Delete a memory entry. Returns `true` if the entry existed and was deleted.
    pub async fn delete(&self, name: &str) -> Result<bool> {
        let path = self.entry_path(name)?;
        if !path.is_file() {
            return Ok(false);
        }
        tokio::fs::remove_file(&path)
            .await
            .with_context(|| format!("failed to delete memory file: {}", path.display()))?;
        Ok(true)
    }

    /// Build a context string from all memories.
    ///
    /// Formats all entries as markdown sections suitable for inclusion in a system prompt.
    pub async fn build_memory_context(&self) -> Result<String> {
        let entries = self.list().await?;
        if entries.is_empty() {
            return Ok(String::new());
        }

        let mut parts = Vec::new();
        for entry in &entries {
            parts.push(format!(
                "## {}\n> {}\n\n{}\n",
                entry.name, entry.description, entry.content
            ));
        }

        Ok(parts.join("\n"))
    }

    /// Compute the file path for a named entry, validating it doesn't escape root.
    fn entry_path(&self, name: &str) -> Result<PathBuf> {
        // Sanitize the name: only allow alphanumeric, dashes, underscores, dots.
        ensure!(
            is_safe_name(name),
            "invalid memory entry name: {:?} (only alphanumeric, dashes, underscores, dots allowed)",
            name
        );

        let filename = format!("{name}.md");
        let path = self.root.join(&filename);

        // Canonicalize root if it exists, otherwise verify by construction.
        // Since we only join a single sanitized component, path traversal is not possible.
        // But let's be defensive: verify the resolved path is under root.
        if self.root.is_dir() {
            let canonical_root = self.root.canonicalize().with_context(|| {
                format!(
                    "failed to canonicalize memory root: {}",
                    self.root.display()
                )
            })?;
            // Use parent of path to check directory membership.
            let parent = path.parent().context("memory entry path has no parent")?;
            let canonical_parent = parent.canonicalize().with_context(|| {
                format!(
                    "failed to canonicalize memory entry parent: {}",
                    parent.display()
                )
            })?;
            ensure!(
                canonical_parent == canonical_root,
                "memory entry path escapes root directory"
            );
        }

        Ok(path)
    }

    /// Parse a memory file from disk.
    async fn parse_memory_file(&self, path: &Path) -> Result<Option<MemoryEntry>> {
        let raw = match tokio::fs::read_to_string(path).await {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(e)
                    .with_context(|| format!("failed to read memory file: {}", path.display()));
            }
        };

        let entry = parse_entry(&raw, path)?;
        Ok(Some(entry))
    }
}

/// Check if a name contains only safe characters (no path traversal).
fn is_safe_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    name.chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.contains("..")
}

/// Serialize a memory entry to the markdown + frontmatter format.
fn serialize_entry(entry: &MemoryEntry) -> String {
    format!(
        "---\nname: {}\ndescription: {}\nmetadata:\n  type: {}\n  updated: {}\n---\n\n{}",
        entry.name,
        entry.description,
        serde_json::to_value(entry.metadata.entry_type)
            .map(|v| match v {
                serde_json::Value::String(s) => s,
                other => other.to_string(),
            })
            .unwrap_or_else(|_| "user".to_string()),
        entry.metadata.updated,
        entry.content,
    )
}

/// Parse a memory entry from the markdown + frontmatter format.
fn parse_entry(raw: &str, source_path: &Path) -> Result<MemoryEntry> {
    // Extract frontmatter between --- delimiters.
    let trimmed = raw.trim_start();
    ensure!(
        trimmed.starts_with("---"),
        "memory file missing frontmatter: {}",
        source_path.display()
    );

    let after_first = &trimmed[3..];
    let end_marker = after_first.find("\n---").ok_or_else(|| {
        anyhow::anyhow!(
            "memory file missing closing frontmatter delimiter: {}",
            source_path.display()
        )
    })?;

    let frontmatter = &after_first[..end_marker];
    let content = after_first[end_marker + 4..]
        .trim_start_matches('\n')
        .trim_end();

    // Parse frontmatter fields.
    let name = parse_frontmatter_field(frontmatter, "name").ok_or_else(|| {
        anyhow::anyhow!(
            "memory file missing 'name' field: {}",
            source_path.display()
        )
    })?;
    let description = parse_frontmatter_field(frontmatter, "description").unwrap_or_default();
    let entry_type_str =
        parse_frontmatter_field(frontmatter, "type").unwrap_or_else(|| "user".to_string());
    let updated =
        parse_frontmatter_field(frontmatter, "updated").unwrap_or_else(|| "unknown".to_string());

    let entry_type = serde_json::from_value(serde_json::Value::String(entry_type_str))
        .unwrap_or(MemoryType::User);

    Ok(MemoryEntry {
        name,
        description,
        content: content.to_string(),
        metadata: MemoryMetadata {
            entry_type,
            updated,
        },
    })
}

/// Extract a field value from YAML-like frontmatter.
///
/// Looks for lines matching `key: value` or nested `  key: value` (for metadata section).
fn parse_frontmatter_field(frontmatter: &str, field: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let trimmed_line = line.trim();
        if let Some(rest) = trimmed_line.strip_prefix(&format!("{field}:")) {
            return Some(rest.trim().to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create a temporary memory store.
    async fn temp_store() -> (tempfile::TempDir, MemoryStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(dir.path().join("memory"));
        (dir, store)
    }

    fn sample_entry(name: &str) -> MemoryEntry {
        MemoryEntry {
            name: name.to_string(),
            description: format!("Description for {name}"),
            content: format!("Content of {name} memory entry."),
            metadata: MemoryMetadata {
                entry_type: MemoryType::Feedback,
                updated: "2026-06-09".to_string(),
            },
        }
    }

    #[test]
    fn is_safe_name_accepts_valid_names() {
        assert!(is_safe_name("user-preferences"));
        assert!(is_safe_name("my_config"));
        assert!(is_safe_name("notes"));
        assert!(is_safe_name("v2.0"));
        assert!(is_safe_name("a"));
    }

    #[test]
    fn is_safe_name_rejects_invalid_names() {
        assert!(!is_safe_name(""));
        assert!(!is_safe_name("../escape"));
        assert!(!is_safe_name("name with spaces"));
        assert!(!is_safe_name("name/slash"));
        assert!(!is_safe_name("name\\backslash"));
        assert!(!is_safe_name(".."));
    }

    #[tokio::test]
    async fn write_and_read_roundtrip() {
        let (_dir, store) = temp_store().await;
        let entry = sample_entry("test-entry");

        store.write(&entry).await.unwrap();

        let read_back = store.read("test-entry").await.unwrap().unwrap();

        assert_eq!(read_back.name, entry.name);
        assert_eq!(read_back.description, entry.description);
        assert_eq!(read_back.content, entry.content);
        assert_eq!(read_back.metadata.entry_type, entry.metadata.entry_type);
        assert_eq!(read_back.metadata.updated, entry.metadata.updated);
    }

    #[tokio::test]
    async fn read_returns_none_for_missing_entry() {
        let (_dir, store) = temp_store().await;

        let result = store.read("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn list_returns_all_written_entries() {
        let (_dir, store) = temp_store().await;

        let entry_a = sample_entry("alpha");
        let entry_b = sample_entry("beta");
        let entry_c = sample_entry("gamma");

        store.write(&entry_a).await.unwrap();
        store.write(&entry_b).await.unwrap();
        store.write(&entry_c).await.unwrap();

        let entries = store.list().await.unwrap();
        assert_eq!(entries.len(), 3);

        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Sorted by name.
        assert_eq!(names, vec!["alpha", "beta", "gamma"]);
    }

    #[tokio::test]
    async fn list_returns_empty_for_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(dir.path().join("does-not-exist"));

        let entries = store.list().await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn delete_removes_entry() {
        let (_dir, store) = temp_store().await;
        let entry = sample_entry("to-delete");

        store.write(&entry).await.unwrap();
        assert!(store.read("to-delete").await.unwrap().is_some());

        let deleted = store.delete("to-delete").await.unwrap();
        assert!(deleted);
        assert!(store.read("to-delete").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_returns_false_for_missing_entry() {
        let (_dir, store) = temp_store().await;

        let deleted = store.delete("nonexistent").await.unwrap();
        assert!(!deleted);
    }

    #[tokio::test]
    async fn build_memory_context_formats_all_entries() {
        let (_dir, store) = temp_store().await;

        let mut entry1 = sample_entry("style-guide");
        entry1.description = "Code style preferences".to_string();
        entry1.content = "Use tabs. Prefer early returns.".to_string();

        let mut entry2 = sample_entry("project-facts");
        entry2.description = "Key project facts".to_string();
        entry2.content = "This is a Rust project.".to_string();

        store.write(&entry1).await.unwrap();
        store.write(&entry2).await.unwrap();

        let context = store.build_memory_context().await.unwrap();

        assert!(context.contains("## project-facts"));
        assert!(context.contains("> Key project facts"));
        assert!(context.contains("This is a Rust project."));
        assert!(context.contains("## style-guide"));
        assert!(context.contains("> Code style preferences"));
        assert!(context.contains("Use tabs. Prefer early returns."));
    }

    #[tokio::test]
    async fn build_memory_context_empty_store() {
        let (_dir, store) = temp_store().await;

        let context = store.build_memory_context().await.unwrap();
        assert!(context.is_empty());
    }

    #[tokio::test]
    async fn write_updates_existing_entry() {
        let (_dir, store) = temp_store().await;

        let mut entry = sample_entry("mutable");
        entry.content = "original content".to_string();
        store.write(&entry).await.unwrap();

        entry.content = "updated content".to_string();
        entry.metadata.updated = "2026-06-10".to_string();
        store.write(&entry).await.unwrap();

        let read_back = store.read("mutable").await.unwrap().unwrap();
        assert_eq!(read_back.content, "updated content");
        assert_eq!(read_back.metadata.updated, "2026-06-10");
    }

    #[tokio::test]
    async fn reject_path_traversal_name() {
        let (_dir, store) = temp_store().await;

        let result = store
            .write(&MemoryEntry {
                name: "../escape".to_string(),
                description: "bad".to_string(),
                content: "bad".to_string(),
                metadata: MemoryMetadata {
                    entry_type: MemoryType::User,
                    updated: "2026-01-01".to_string(),
                },
            })
            .await;

        assert!(result.is_err());
    }

    #[test]
    fn memory_type_serde_roundtrip() {
        for mt in [
            MemoryType::User,
            MemoryType::Feedback,
            MemoryType::Project,
            MemoryType::Reference,
        ] {
            let json = serde_json::to_string(&mt).unwrap();
            let back: MemoryType = serde_json::from_str(&json).unwrap();
            assert_eq!(back, mt);
        }
    }

    #[test]
    fn memory_type_renames() {
        assert_eq!(
            serde_json::to_string(&MemoryType::Feedback).unwrap(),
            "\"feedback\""
        );
        assert_eq!(
            serde_json::to_string(&MemoryType::Reference).unwrap(),
            "\"reference\""
        );
    }

    #[test]
    fn parse_frontmatter_field_extracts_value() {
        let fm = "name: my-entry\ndescription: A test entry\nmetadata:\n  type: feedback\n  updated: 2026-06-09";
        assert_eq!(
            parse_frontmatter_field(fm, "name"),
            Some("my-entry".to_string())
        );
        assert_eq!(
            parse_frontmatter_field(fm, "description"),
            Some("A test entry".to_string())
        );
        assert_eq!(
            parse_frontmatter_field(fm, "type"),
            Some("feedback".to_string())
        );
        assert_eq!(
            parse_frontmatter_field(fm, "updated"),
            Some("2026-06-09".to_string())
        );
        assert_eq!(parse_frontmatter_field(fm, "missing"), None);
    }

    #[test]
    fn serialize_and_parse_roundtrip() {
        let entry = MemoryEntry {
            name: "roundtrip-test".to_string(),
            description: "Test roundtrip".to_string(),
            content: "Some content here.".to_string(),
            metadata: MemoryMetadata {
                entry_type: MemoryType::Project,
                updated: "2026-06-09".to_string(),
            },
        };

        let serialized = serialize_entry(&entry);
        let parsed = parse_entry(&serialized, Path::new("test.md")).unwrap();

        assert_eq!(parsed.name, entry.name);
        assert_eq!(parsed.description, entry.description);
        assert_eq!(parsed.content, entry.content);
        assert_eq!(parsed.metadata.entry_type, entry.metadata.entry_type);
        assert_eq!(parsed.metadata.updated, entry.metadata.updated);
    }
}
