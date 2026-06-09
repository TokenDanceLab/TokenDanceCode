//! Git worktree management for isolated development branches.
//!
//! Provides creation, listing, removal, and status checking of git worktrees
//! located under `.worktrees/` in the main repository root.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tokio::process::Command;

/// Information about a git worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub branch: String,
    pub is_current: bool,
    pub is_clean: bool,
}

/// Manage git worktrees for isolated development.
pub struct WorktreeManager {
    /// Root directory of the main repository.
    repo_root: PathBuf,
    /// Directory where worktrees are created (.worktrees/ inside repo).
    worktrees_dir: PathBuf,
}

impl WorktreeManager {
    pub fn new(repo_root: impl Into<PathBuf>) -> Self {
        let repo_root = repo_root.into();
        let worktrees_dir = repo_root.join(".worktrees");
        Self {
            repo_root,
            worktrees_dir,
        }
    }

    /// List all worktrees.
    pub async fn list(&self) -> Result<Vec<WorktreeInfo>> {
        let output = Command::new("git")
            .args(["worktree", "list", "--porcelain"])
            .current_dir(&self.repo_root)
            .output()
            .await
            .context("failed to run git worktree list")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("git worktree list failed: {stderr}");
        }

        let text = String::from_utf8_lossy(&output.stdout);
        let mut worktrees = Vec::new();

        // Parse porcelain output:
        // Each worktree entry is separated by a blank line.
        // Lines: "worktree <path>", "HEAD <sha>", "branch <ref>", etc.
        let mut current_path: Option<PathBuf> = None;
        let mut current_branch: Option<String> = None;
        let mut is_bare = false;

        for line in text.lines() {
            if line.is_empty() {
                // End of entry — emit if we have a path
                if let Some(path) = current_path.take() {
                    let branch = current_branch
                        .take()
                        .unwrap_or_else(|| "(detached)".to_string());
                    // Determine if this is the current worktree by checking
                    // if it matches the repo root
                    let is_current = path == self.repo_root;
                    let is_clean = self.check_clean_sync(&path);
                    worktrees.push(WorktreeInfo {
                        path,
                        branch,
                        is_current,
                        is_clean,
                    });
                }
                is_bare = false;
                continue;
            }

            if let Some(rest) = line.strip_prefix("worktree ") {
                current_path = Some(PathBuf::from(rest));
            } else if let Some(rest) = line.strip_prefix("branch ") {
                // branch refs/heads/name -> name
                current_branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
            } else if line == "bare" {
                is_bare = true;
            }
        }

        // Handle last entry (no trailing blank line)
        if let Some(path) = current_path.take() {
            let branch = current_branch.unwrap_or_else(|| "(detached)".to_string());
            if !is_bare {
                let is_current = path == self.repo_root;
                let is_clean = self.check_clean_sync(&path);
                worktrees.push(WorktreeInfo {
                    path,
                    branch,
                    is_current,
                    is_clean,
                });
            }
        }

        Ok(worktrees)
    }

    /// Create a new worktree.
    pub async fn create(&self, name: &str, base_branch: Option<&str>) -> Result<PathBuf> {
        // Validate name
        if name.is_empty() {
            bail!("worktree name cannot be empty");
        }
        if name.contains('/') || name.contains('\\') || name.contains(' ') {
            bail!("worktree name cannot contain '/', '\\', or spaces");
        }

        let worktree_path = self.worktrees_dir.join(name);
        if worktree_path.exists() {
            bail!("worktree already exists: {}", worktree_path.display());
        }

        // Ensure .worktrees/ dir exists
        std::fs::create_dir_all(&self.worktrees_dir)
            .context("failed to create .worktrees directory")?;

        let mut args = vec![
            "worktree".to_string(),
            "add".to_string(),
            worktree_path.to_string_lossy().to_string(),
            "-b".to_string(),
            name.to_string(),
        ];

        if let Some(base) = base_branch {
            args.push(base.to_string());
        } else {
            args.push("HEAD".to_string());
        }

        let output = Command::new("git")
            .args(&args)
            .current_dir(&self.repo_root)
            .output()
            .await
            .context("failed to run git worktree add")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("git worktree add failed: {stderr}");
        }

        Ok(worktree_path)
    }

    /// Remove a worktree.
    pub async fn remove(&self, name: &str, force: bool) -> Result<()> {
        let worktree_path = self.worktrees_dir.join(name);
        if !worktree_path.exists() {
            bail!("worktree does not exist: {}", worktree_path.display());
        }

        let mut args = vec!["worktree".to_string(), "remove".to_string()];
        if force {
            args.push("--force".to_string());
        }
        args.push(worktree_path.to_string_lossy().to_string());

        let output = Command::new("git")
            .args(&args)
            .current_dir(&self.repo_root)
            .output()
            .await
            .context("failed to run git worktree remove")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("git worktree remove failed: {stderr}");
        }

        Ok(())
    }

    /// Check if a worktree exists.
    pub async fn exists(&self, name: &str) -> bool {
        self.worktrees_dir.join(name).exists()
    }

    /// Get the path for a named worktree.
    pub fn path_for(&self, name: &str) -> PathBuf {
        self.worktrees_dir.join(name)
    }

    /// Check if a worktree is clean (no uncommitted changes).
    pub async fn is_clean(&self, name: &str) -> Result<bool> {
        let worktree_path = self.worktrees_dir.join(name);
        if !worktree_path.exists() {
            bail!("worktree does not exist: {}", worktree_path.display());
        }

        let output = Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&worktree_path)
            .output()
            .await
            .context("failed to run git status")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("git status failed: {stderr}");
        }

        let text = String::from_utf8_lossy(&output.stdout);
        Ok(text.trim().is_empty())
    }

    /// Get the current branch of a worktree.
    pub async fn current_branch(&self, name: &str) -> Result<String> {
        let worktree_path = self.worktrees_dir.join(name);
        if !worktree_path.exists() {
            bail!("worktree does not exist: {}", worktree_path.display());
        }

        let output = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(&worktree_path)
            .output()
            .await
            .context("failed to run git rev-parse")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("git rev-parse failed: {stderr}");
        }

        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(branch)
    }

    /// Synchronous clean check helper (used during list parsing).
    fn check_clean_sync(&self, path: &PathBuf) -> bool {
        std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(path)
            .output()
            .map(|o| {
                let text = String::from_utf8_lossy(&o.stdout);
                text.trim().is_empty()
            })
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to initialize a temporary git repo with an initial commit.
    async fn init_temp_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();

        // git init
        let init_output = Command::new("git")
            .args(["init"])
            .current_dir(repo)
            .output()
            .await
            .expect("git init should work");
        assert!(init_output.status.success(), "git init failed");

        // Configure user for commits
        Command::new("git")
            .args(["config", "user.email", "test@tokendance.dev"])
            .current_dir(repo)
            .output()
            .await
            .expect("git config email should work");

        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(repo)
            .output()
            .await
            .expect("git config name should work");

        // Initial commit
        let commit_output = Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init"])
            .current_dir(repo)
            .output()
            .await
            .expect("git commit should work");
        assert!(commit_output.status.success(), "git commit failed");

        tmp
    }

    #[tokio::test]
    async fn worktree_manager_creates_and_lists() {
        let tmp = init_temp_repo().await;
        let mgr = WorktreeManager::new(tmp.path());

        let path = mgr
            .create("feature-branch", None)
            .await
            .expect("create should succeed");
        assert!(path.exists());
        assert!(path.ends_with(".worktrees/feature-branch"));

        let worktrees = mgr.list().await.expect("list should succeed");
        // Should have at least the main worktree + our new one
        assert!(worktrees.len() >= 2);
        let feature = worktrees
            .iter()
            .find(|w| w.branch == "feature-branch")
            .expect("feature-branch worktree should be listed");
        assert_eq!(feature.path, path);
    }

    #[tokio::test]
    async fn worktree_manager_removes_worktree() {
        let tmp = init_temp_repo().await;
        let mgr = WorktreeManager::new(tmp.path());

        mgr.create("to-remove", None)
            .await
            .expect("create should succeed");
        assert!(mgr.exists("to-remove").await);

        mgr.remove("to-remove", false)
            .await
            .expect("remove should succeed");
        assert!(!mgr.exists("to-remove").await);
    }

    #[tokio::test]
    async fn worktree_exists_check() {
        let tmp = init_temp_repo().await;
        let mgr = WorktreeManager::new(tmp.path());

        assert!(!mgr.exists("nonexistent").await);

        mgr.create("existing", None)
            .await
            .expect("create should succeed");
        assert!(mgr.exists("existing").await);
    }

    #[test]
    fn worktree_path_for_returns_correct_path() {
        let mgr = WorktreeManager::new("/repo/root");
        assert_eq!(
            mgr.path_for("my-feature"),
            PathBuf::from("/repo/root/.worktrees/my-feature")
        );
    }

    #[tokio::test]
    async fn worktree_is_clean_on_fresh_worktree() {
        let tmp = init_temp_repo().await;
        let mgr = WorktreeManager::new(tmp.path());

        mgr.create("clean-check", None)
            .await
            .expect("create should succeed");
        let clean = mgr
            .is_clean("clean-check")
            .await
            .expect("is_clean should succeed");
        assert!(clean, "fresh worktree should be clean");
    }

    #[tokio::test]
    async fn worktree_create_rejects_empty_name() {
        let tmp = init_temp_repo().await;
        let mgr = WorktreeManager::new(tmp.path());

        let result = mgr.create("", None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
    }

    #[tokio::test]
    async fn worktree_create_rejects_slash_in_name() {
        let tmp = init_temp_repo().await;
        let mgr = WorktreeManager::new(tmp.path());

        let result = mgr.create("no/slash", None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn worktree_current_branch() {
        let tmp = init_temp_repo().await;
        let mgr = WorktreeManager::new(tmp.path());

        mgr.create("branch-check", None)
            .await
            .expect("create should succeed");
        let branch = mgr
            .current_branch("branch-check")
            .await
            .expect("current_branch should succeed");
        assert_eq!(branch, "branch-check");
    }

    #[tokio::test]
    async fn worktree_create_with_base_branch() {
        let tmp = init_temp_repo().await;
        let repo = tmp.path();

        // Create a branch "develop" in main repo first
        Command::new("git")
            .args(["branch", "develop"])
            .current_dir(repo)
            .output()
            .await
            .expect("git branch develop");

        let mgr = WorktreeManager::new(repo);
        let path = mgr
            .create("feature-from-develop", Some("develop"))
            .await
            .expect("create with base should succeed");
        assert!(path.exists());
    }
}
