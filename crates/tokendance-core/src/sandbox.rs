//! Platform-abstracted sandboxing system for command execution.
//!
//! Inspired by Codex's sandboxing crate. Provides a policy layer with
//! Windows restricted-token stub and Linux/macOS placeholders.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Type of sandbox to use for command execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxType {
    /// No sandboxing
    None,
    /// Windows restricted token
    WindowsRestrictedToken,
    /// macOS Seatbelt (sandbox-exec)
    MacosSeatbelt,
    /// Linux bubblewrap (bwrap)
    LinuxBubblewrap,
}

impl std::fmt::Display for SandboxType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SandboxType::None => write!(f, "none"),
            SandboxType::WindowsRestrictedToken => write!(f, "windows_restricted_token"),
            SandboxType::MacosSeatbelt => write!(f, "macos_seatbelt"),
            SandboxType::LinuxBubblewrap => write!(f, "linux_bubblewrap"),
        }
    }
}

/// Filesystem access policy for sandboxed execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilesystemPolicy {
    /// Directories allowed for read access.
    #[serde(default)]
    pub read_allowed: Vec<PathBuf>,
    /// Directories allowed for write access.
    #[serde(default)]
    pub write_allowed: Vec<PathBuf>,
    /// Paths that are always denied (e.g., .git, .ssh).
    #[serde(default)]
    pub denied_paths: Vec<PathBuf>,
}

impl Default for FilesystemPolicy {
    fn default() -> Self {
        Self {
            read_allowed: vec![PathBuf::from(".")],
            write_allowed: vec![PathBuf::from(".")],
            denied_paths: vec![
                PathBuf::from(".git"),
                PathBuf::from(".ssh"),
                PathBuf::from(".gnupg"),
            ],
        }
    }
}

/// Network access policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    /// No network access
    Denied,
    /// Full network access
    Allowed,
    /// Only specific domains (not yet implemented)
    Restricted,
}

impl Default for NetworkPolicy {
    fn default() -> Self {
        Self::Allowed
    }
}

/// Complete sandbox configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxConfig {
    pub sandbox_type: SandboxType,
    pub filesystem: FilesystemPolicy,
    pub network: NetworkPolicy,
    pub working_directory: PathBuf,
}

impl SandboxConfig {
    /// Create a config appropriate for the current platform.
    pub fn for_platform(work_dir: impl Into<PathBuf>) -> Self {
        let sandbox_type = if cfg!(target_os = "windows") {
            SandboxType::WindowsRestrictedToken
        } else if cfg!(target_os = "macos") {
            SandboxType::MacosSeatbelt
        } else {
            SandboxType::LinuxBubblewrap
        };
        Self {
            sandbox_type,
            filesystem: FilesystemPolicy::default(),
            network: NetworkPolicy::default(),
            working_directory: work_dir.into(),
        }
    }

    /// Create a no-sandbox config.
    pub fn none(work_dir: impl Into<PathBuf>) -> Self {
        Self {
            sandbox_type: SandboxType::None,
            filesystem: FilesystemPolicy::default(),
            network: NetworkPolicy::Allowed,
            working_directory: work_dir.into(),
        }
    }
}

/// Result of checking sandbox availability.
#[derive(Debug, Clone)]
pub struct SandboxAvailability {
    pub available: bool,
    pub sandbox_type: SandboxType,
    pub reason: Option<String>,
}

/// Check if sandboxing is available on this platform.
pub fn check_sandbox_availability() -> SandboxAvailability {
    if cfg!(target_os = "windows") {
        // Windows restricted tokens are always available
        SandboxAvailability {
            available: true,
            sandbox_type: SandboxType::WindowsRestrictedToken,
            reason: None,
        }
    } else if cfg!(target_os = "macos") {
        // Check if sandbox-exec exists
        SandboxAvailability {
            available: true,
            sandbox_type: SandboxType::MacosSeatbelt,
            reason: None,
        }
    } else if cfg!(target_os = "linux") {
        // Check if bwrap exists
        SandboxAvailability {
            available: false, // Stub for now
            sandbox_type: SandboxType::LinuxBubblewrap,
            reason: Some("bubblewrap not yet supported".to_string()),
        }
    } else {
        SandboxAvailability {
            available: false,
            sandbox_type: SandboxType::None,
            reason: Some("unsupported platform".to_string()),
        }
    }
}

/// Build sandboxed command arguments for the platform.
/// Returns additional args to prepend to the command for sandboxing.
pub fn build_sandbox_args(config: &SandboxConfig) -> Vec<String> {
    match config.sandbox_type {
        SandboxType::None => Vec::new(),
        SandboxType::WindowsRestrictedToken => {
            // Windows: no prepended args, sandboxing is process-level
            Vec::new()
        }
        SandboxType::MacosSeatbelt => {
            // macOS: generate Seatbelt profile
            let mut args = vec!["sandbox-exec".to_string(), "-p".to_string()];
            let profile = generate_seatbelt_profile(config);
            args.push(profile);
            args
        }
        SandboxType::LinuxBubblewrap => {
            // Linux: generate bwrap args
            let mut args = vec!["bwrap".to_string()];
            for dir in &config.filesystem.read_allowed {
                args.push("--ro-bind".to_string());
                args.push(dir.to_string_lossy().to_string());
                args.push(dir.to_string_lossy().to_string());
            }
            for dir in &config.filesystem.write_allowed {
                args.push("--bind".to_string());
                args.push(dir.to_string_lossy().to_string());
                args.push(dir.to_string_lossy().to_string());
            }
            args.push("--".to_string());
            args
        }
    }
}

/// Generate a macOS Seatbelt profile string.
fn generate_seatbelt_profile(config: &SandboxConfig) -> String {
    let mut rules = Vec::new();
    for dir in &config.filesystem.read_allowed {
        rules.push(format!(
            "(allow file-read* (subpath \"{}\"))",
            dir.display()
        ));
    }
    for dir in &config.filesystem.write_allowed {
        rules.push(format!(
            "(allow file-write* (subpath \"{}\"))",
            dir.display()
        ));
    }
    for path in &config.filesystem.denied_paths {
        rules.push(format!("(deny file* (subpath \"{}\"))", path.display()));
    }
    if config.network == NetworkPolicy::Denied {
        rules.push("(deny network*)".to_string());
    }
    format!("(version 1)(deny default)({})", rules.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filesystem_policy_default_has_denied_paths() {
        let policy = FilesystemPolicy::default();
        assert!(policy.denied_paths.contains(&PathBuf::from(".git")));
        assert!(policy.denied_paths.contains(&PathBuf::from(".ssh")));
        assert!(policy.denied_paths.contains(&PathBuf::from(".gnupg")));
        assert_eq!(policy.denied_paths.len(), 3);
    }

    #[test]
    fn sandbox_config_for_platform_selects_correctly() {
        let config = SandboxConfig::for_platform("/tmp/work");
        #[cfg(target_os = "windows")]
        assert_eq!(config.sandbox_type, SandboxType::WindowsRestrictedToken);
        #[cfg(target_os = "macos")]
        assert_eq!(config.sandbox_type, SandboxType::MacosSeatbelt);
        #[cfg(target_os = "linux")]
        assert_eq!(config.sandbox_type, SandboxType::LinuxBubblewrap);
        assert_eq!(config.working_directory, PathBuf::from("/tmp/work"));
    }

    #[test]
    fn sandbox_config_none_disables_sandbox() {
        let config = SandboxConfig::none("/tmp/work");
        assert_eq!(config.sandbox_type, SandboxType::None);
        assert_eq!(config.working_directory, PathBuf::from("/tmp/work"));
        assert_eq!(config.network, NetworkPolicy::Allowed);
    }

    #[test]
    fn sandbox_availability_check_returns_result() {
        let avail = check_sandbox_availability();
        #[cfg(target_os = "windows")]
        {
            assert!(avail.available);
            assert_eq!(avail.sandbox_type, SandboxType::WindowsRestrictedToken);
            assert!(avail.reason.is_none());
        }
        #[cfg(target_os = "macos")]
        {
            assert!(avail.available);
            assert_eq!(avail.sandbox_type, SandboxType::MacosSeatbelt);
        }
        #[cfg(target_os = "linux")]
        {
            assert!(!avail.available);
            assert_eq!(avail.sandbox_type, SandboxType::LinuxBubblewrap);
        }
    }

    #[test]
    fn build_sandbox_args_none_returns_empty() {
        let config = SandboxConfig::none("/tmp/work");
        let args = build_sandbox_args(&config);
        assert!(args.is_empty());
    }

    #[test]
    fn build_sandbox_args_seatbelt_generates_profile() {
        let mut config = SandboxConfig::none("/tmp/work");
        config.sandbox_type = SandboxType::MacosSeatbelt;
        let args = build_sandbox_args(&config);
        assert!(args.len() >= 3);
        assert_eq!(args[0], "sandbox-exec");
        assert_eq!(args[1], "-p");
        // The profile should contain the Seatbelt header
        assert!(args[2].contains("(version 1)"));
        assert!(args[2].contains("(deny default)"));
    }

    #[test]
    fn build_sandbox_args_bwrap_generates_args() {
        let mut config = SandboxConfig::none("/tmp/work");
        config.sandbox_type = SandboxType::LinuxBubblewrap;
        let args = build_sandbox_args(&config);
        assert!(!args.is_empty());
        assert_eq!(args[0], "bwrap");
        // Default policy has "." for read and write
        assert!(args.contains(&"--ro-bind".to_string()));
        assert!(args.contains(&"--bind".to_string()));
        // Should end with "--" separator
        assert_eq!(args.last().unwrap(), "--");
    }

    #[test]
    fn seatbelt_profile_denies_git() {
        let mut config = SandboxConfig::none("/tmp/work");
        config.sandbox_type = SandboxType::MacosSeatbelt;
        let args = build_sandbox_args(&config);
        let profile = &args[2];
        assert!(
            profile.contains("(deny file* (subpath \".git\"))"),
            "profile should deny .git: {profile}"
        );
        assert!(
            profile.contains("(deny file* (subpath \".ssh\"))"),
            "profile should deny .ssh: {profile}"
        );
    }

    #[test]
    fn network_policy_denied_adds_deny_rule() {
        let mut config = SandboxConfig::none("/tmp/work");
        config.sandbox_type = SandboxType::MacosSeatbelt;
        config.network = NetworkPolicy::Denied;
        let args = build_sandbox_args(&config);
        let profile = &args[2];
        assert!(
            profile.contains("(deny network*)"),
            "profile should deny network: {profile}"
        );
    }

    #[test]
    fn sandbox_type_display() {
        assert_eq!(SandboxType::None.to_string(), "none");
        assert_eq!(
            SandboxType::WindowsRestrictedToken.to_string(),
            "windows_restricted_token"
        );
        assert_eq!(SandboxType::MacosSeatbelt.to_string(), "macos_seatbelt");
        assert_eq!(SandboxType::LinuxBubblewrap.to_string(), "linux_bubblewrap");
    }

    #[test]
    fn filesystem_policy_serializes_to_snake_case_json() {
        let policy = FilesystemPolicy::default();
        let value = serde_json::to_value(&policy).unwrap();
        assert!(value["read_allowed"].is_array());
        assert!(value["write_allowed"].is_array());
        assert!(value["denied_paths"].is_array());
    }

    #[test]
    fn sandbox_config_roundtrip_json() {
        let config = SandboxConfig::for_platform("/work");
        let json = serde_json::to_string(&config).unwrap();
        let parsed: SandboxConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sandbox_type, config.sandbox_type);
        assert_eq!(parsed.network, config.network);
        assert_eq!(parsed.working_directory, config.working_directory);
    }
}
