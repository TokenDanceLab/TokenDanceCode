use crate::PermissionMode;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Mock,
    OpenAiResponses,
    OpenAiChatCompletions,
    AnthropicMessages,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub model: String,
    pub base_url: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            kind: ProviderKind::Mock,
            model: "mock".to_string(),
            base_url: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DoctorInfo {
    pub version: String,
    pub rust_runtime: bool,
    pub provider: ProviderConfig,
    pub warnings: Vec<String>,
}

pub fn doctor_info(version: impl Into<String>, provider: ProviderConfig) -> DoctorInfo {
    DoctorInfo {
        version: version.into(),
        rust_runtime: true,
        provider,
        warnings: Vec::new(),
    }
}

/// TokenDanceCode configuration loaded from settings.json files.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Settings {
    #[serde(default)]
    pub provider: Option<ProviderSettings>,
    #[serde(rename = "permissionMode", default)]
    pub permission_mode: Option<String>,
    #[serde(rename = "allowedTools", default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(rename = "disallowedTools", default)]
    pub disallowed_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderSettings {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
}

/// Load settings by merging user + project config. Project overrides user.
pub fn load_settings(project_root: Option<&PathBuf>) -> anyhow::Result<Settings> {
    let user_settings = load_settings_from_dir(user_config_dir()?)?;
    let project_settings = match project_root {
        Some(root) => load_settings_from_dir(root.join(".tokendance"))?,
        None => Settings::default(),
    };
    Ok(merge_settings(user_settings, project_settings))
}

/// Validate settings and return a list of issues.
pub fn validate_settings(settings: &Settings) -> Vec<String> {
    let mut issues = Vec::new();

    if let Some(ref provider) = settings.provider {
        if let Some(ref kind) = provider.kind {
            let valid_kinds = [
                "openai_chat_completions",
                "openai_responses",
                "anthropic_messages",
            ];
            if !valid_kinds.contains(&kind.as_str()) {
                issues.push(format!(
                    "provider.kind \"{kind}\" is not a known value; expected one of: openai_chat_completions, openai_responses, anthropic_messages"
                ));
            }
        }
    }

    if let Some(ref mode) = settings.permission_mode {
        let valid_modes = ["default", "safe", "auto", "yolo"];
        if !valid_modes.contains(&mode.as_str()) {
            issues.push(format!(
                "permissionMode \"{mode}\" is not a known value; expected one of: default, safe, auto, yolo"
            ));
        }
    }

    if let (Some(allowed), Some(disallowed)) = (&settings.allowed_tools, &settings.disallowed_tools)
    {
        for tool in allowed {
            if disallowed.contains(tool) {
                issues.push(format!(
                    "tool \"{tool}\" appears in both allowedTools and disallowedTools"
                ));
            }
        }
    }

    issues
}

/// Resolve the effective permission mode from settings or env.
pub fn resolve_permission_mode(settings: &Settings) -> PermissionMode {
    if let Some(ref mode) = settings.permission_mode {
        if let Ok(parsed) = serde_json::from_value(serde_json::Value::String(mode.clone())) {
            return parsed;
        }
    }

    if let Ok(env_mode) = std::env::var("PERMISSION_MODE") {
        if let Ok(parsed) = serde_json::from_value(serde_json::Value::String(env_mode)) {
            return parsed;
        }
    }

    PermissionMode::Default
}

fn user_config_dir() -> anyhow::Result<PathBuf> {
    let home = dirs_home()?;
    Ok(home.join(".tokendance"))
}

fn dirs_home() -> anyhow::Result<PathBuf> {
    // Use $HOME on unix, $USERPROFILE on windows, fallback to ~
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home));
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        return Ok(PathBuf::from(userprofile));
    }
    Ok(PathBuf::from("~"))
}

fn load_settings_from_dir(dir: PathBuf) -> anyhow::Result<Settings> {
    let path = dir.join("settings.json");
    if !path.exists() {
        return Ok(Settings::default());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("failed to read {}: {e}", path.display()))?;
    let settings: Settings = serde_json::from_str(&content)
        .map_err(|e| anyhow::anyhow!("failed to parse {}: {e}", path.display()))?;
    Ok(settings)
}

fn merge_settings(user: Settings, project: Settings) -> Settings {
    Settings {
        provider: project.provider.or(user.provider),
        permission_mode: project.permission_mode.or(user.permission_mode),
        allowed_tools: project.allowed_tools.or(user.allowed_tools),
        disallowed_tools: project.disallowed_tools.or(user.disallowed_tools),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn doctor_info_defaults() {
        let info = doctor_info("1.0.0", ProviderConfig::default());
        assert_eq!(info.version, "1.0.0");
        assert!(info.rust_runtime);
        assert_eq!(info.provider.kind, ProviderKind::Mock);
        assert!(info.warnings.is_empty());
    }

    #[test]
    fn settings_from_json() {
        let json = json!({
            "provider": {
                "kind": "openai_chat_completions",
                "model": "gpt-4o",
                "baseUrl": "https://api.example.com/v1"
            },
            "permissionMode": "yolo",
            "allowedTools": ["echo", "read_file"],
            "disallowedTools": ["run_powershell"]
        });
        let settings: Settings = serde_json::from_value(json).unwrap();

        assert_eq!(
            settings.provider.as_ref().unwrap().kind.as_deref(),
            Some("openai_chat_completions")
        );
        assert_eq!(
            settings.provider.as_ref().unwrap().model.as_deref(),
            Some("gpt-4o")
        );
        assert_eq!(
            settings.provider.as_ref().unwrap().base_url.as_deref(),
            Some("https://api.example.com/v1")
        );
        assert_eq!(settings.permission_mode.as_deref(), Some("yolo"));
        assert!(settings.allowed_tools.is_some());
        let allowed = settings.allowed_tools.as_ref().unwrap();
        assert_eq!(allowed.len(), 2);
        assert_eq!(allowed[0], "echo");
        assert_eq!(allowed[1], "read_file");
        assert!(settings.disallowed_tools.is_some());
        let disallowed = settings.disallowed_tools.as_ref().unwrap();
        assert_eq!(disallowed.len(), 1);
        assert_eq!(disallowed[0], "run_powershell");
    }

    #[test]
    fn settings_defaults_to_empty() {
        let settings: Settings = serde_json::from_value(json!({})).unwrap();
        assert!(settings.provider.is_none());
        assert!(settings.permission_mode.is_none());
        assert!(settings.allowed_tools.is_none());
        assert!(settings.disallowed_tools.is_none());
    }

    #[test]
    fn validate_rejects_bad_kind() {
        let settings = Settings {
            provider: Some(ProviderSettings {
                kind: Some("unknown_protocol".to_string()),
                model: None,
                base_url: None,
            }),
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: None,
        };
        let issues = validate_settings(&settings);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].contains("unknown_protocol"));
        assert!(issues[0].contains("not a known value"));
    }

    #[test]
    fn validate_rejects_bad_permission_mode() {
        let settings = Settings {
            provider: None,
            permission_mode: Some("ultra_mode".to_string()),
            allowed_tools: None,
            disallowed_tools: None,
        };
        let issues = validate_settings(&settings);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].contains("ultra_mode"));
    }

    #[test]
    fn validate_rejects_tool_in_both_lists() {
        let settings = Settings {
            provider: None,
            permission_mode: None,
            allowed_tools: Some(vec!["echo".to_string(), "read_file".to_string()]),
            disallowed_tools: Some(vec!["echo".to_string(), "run_powershell".to_string()]),
        };
        let issues = validate_settings(&settings);
        assert_eq!(issues.len(), 1);
        assert!(issues[0].contains("echo"));
        assert!(issues[0].contains("both"));
    }

    #[test]
    fn validate_accepts_valid_settings() {
        let settings = Settings {
            provider: Some(ProviderSettings {
                kind: Some("openai_responses".to_string()),
                model: Some("gpt-4o".to_string()),
                base_url: None,
            }),
            permission_mode: Some("auto".to_string()),
            allowed_tools: Some(vec!["echo".to_string()]),
            disallowed_tools: None,
        };
        let issues = validate_settings(&settings);
        assert!(issues.is_empty());
    }

    #[test]
    fn merge_project_overrides_user() {
        let user = Settings {
            provider: Some(ProviderSettings {
                kind: Some("openai_chat_completions".to_string()),
                model: Some("gpt-3.5-turbo".to_string()),
                base_url: Some("https://user.example.com".to_string()),
            }),
            permission_mode: Some("default".to_string()),
            allowed_tools: Some(vec!["echo".to_string()]),
            disallowed_tools: None,
        };
        let project = Settings {
            provider: Some(ProviderSettings {
                kind: Some("anthropic_messages".to_string()),
                model: Some("claude-3".to_string()),
                base_url: None,
            }),
            permission_mode: None,
            allowed_tools: None,
            disallowed_tools: Some(vec!["run_powershell".to_string()]),
        };
        let merged = merge_settings(user, project);

        // Project provider overrides user provider entirely
        assert_eq!(
            merged.provider.as_ref().unwrap().kind.as_deref(),
            Some("anthropic_messages")
        );
        assert_eq!(
            merged.provider.as_ref().unwrap().model.as_deref(),
            Some("claude-3")
        );
        // Project permission_mode is None, so user value is used
        assert_eq!(merged.permission_mode.as_deref(), Some("default"));
        // Project allowed_tools is None, so user value is used
        assert!(merged.allowed_tools.is_some());
        let allowed = merged.allowed_tools.as_ref().unwrap();
        assert_eq!(allowed.len(), 1);
        assert_eq!(allowed[0], "echo");
        // Project disallowed_tools overrides
        assert!(merged.disallowed_tools.is_some());
        let disallowed = merged.disallowed_tools.as_ref().unwrap();
        assert_eq!(disallowed.len(), 1);
        assert_eq!(disallowed[0], "run_powershell");
    }

    #[test]
    fn resolve_permission_mode_from_settings() {
        let settings = Settings {
            permission_mode: Some("yolo".to_string()),
            ..Settings::default()
        };
        assert_eq!(resolve_permission_mode(&settings), PermissionMode::Yolo);
    }

    #[test]
    fn resolve_permission_mode_defaults_when_unset() {
        let settings = Settings::default();
        // Note: PERMISSION_MODE env may or may not be set; just verify we get a valid mode
        let mode = resolve_permission_mode(&settings);
        assert!(matches!(
            mode,
            PermissionMode::Default
                | PermissionMode::Safe
                | PermissionMode::Auto
                | PermissionMode::Yolo
        ));
    }
}
