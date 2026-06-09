//! MCP (Model Context Protocol) client implementation.
//!
//! Provides a JSON-RPC 2.0 client that communicates with MCP server processes
//! over stdio. The client spawns a server process, initializes the connection,
//! discovers tools, and can call tools and read resources.

use anyhow::{Context, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/// MCP server configuration (from settings or .mcp.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// An MCP tool definition returned by the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Option<serde_json::Value>,
}

/// An MCP resource.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpResource {
    pub uri: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "mimeType", default)]
    pub mime_type: Option<String>,
}

/// The result of calling an MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolResult {
    pub content: Vec<McpContentBlock>,
    #[serde(rename = "isError", default)]
    pub is_error: bool,
}

/// A content block within an MCP tool result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum McpContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

/// A JSON-RPC 2.0 request.
#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    params: serde_json::Value,
}

/// A JSON-RPC 2.0 response (flexible — we only look at `result` or `error`).
#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    #[allow(dead_code)]
    id: Option<u64>,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    #[allow(dead_code)]
    code: i64,
    message: String,
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------

/// A connected MCP server client.
pub struct McpClient {
    name: String,
    process: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    #[allow(dead_code)]
    server_info: Option<serde_json::Value>,
    tools: Vec<McpToolInfo>,
}

impl McpClient {
    /// Spawn an MCP server process and initialize the connection.
    pub async fn connect(name: String, config: &McpServerConfig) -> anyhow::Result<Self> {
        let mut command = tokio::process::Command::new(&config.command);
        command
            .args(&config.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Merge environment variables
        for (key, value) in &config.env {
            command.env(key, value);
        }

        let mut process = command
            .spawn()
            .with_context(|| format!("failed to spawn MCP server '{}'", config.command))?;

        let stdin = process
            .stdin
            .take()
            .ok_or_else(|| anyhow!("MCP server stdin not captured"))?;
        let stdout = process
            .stdout
            .take()
            .ok_or_else(|| anyhow!("MCP server stdout not captured"))?;

        let mut client = Self {
            name,
            process,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            server_info: None,
            tools: Vec::new(),
        };

        // 1. Send "initialize" request
        let init_params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "tokendance",
                "version": env!("CARGO_PKG_VERSION"),
            },
        });

        let init_result = client.send_request("initialize", init_params).await?;
        client.server_info = Some(
            init_result
                .get("serverInfo")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        );

        // 2. Send "notifications/initialized"
        client
            .send_notification(
                "notifications/initialized",
                serde_json::Value::Object(serde_json::Map::new()),
            )
            .await?;

        // 3. Discover tools
        let tools_result = client
            .send_request("tools/list", serde_json::json!({}))
            .await?;
        let tools: Vec<McpToolInfo> = serde_json::from_value(
            tools_result
                .get("tools")
                .cloned()
                .unwrap_or(serde_json::Value::Array(vec![])),
        )
        .context("failed to parse tools/list response")?;
        client.tools = tools;

        Ok(client)
    }

    /// Call a tool on this MCP server.
    pub async fn call_tool(
        &mut self,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> anyhow::Result<McpToolResult> {
        let params = serde_json::json!({
            "name": tool_name,
            "arguments": arguments,
        });

        let result = self.send_request("tools/call", params).await?;
        let tool_result: McpToolResult =
            serde_json::from_value(result).context("failed to parse tools/call response")?;
        Ok(tool_result)
    }

    /// List available resources.
    pub async fn list_resources(&mut self) -> anyhow::Result<Vec<McpResource>> {
        let result = self
            .send_request("resources/list", serde_json::json!({}))
            .await?;
        let resources: Vec<McpResource> = serde_json::from_value(
            result
                .get("resources")
                .cloned()
                .unwrap_or(serde_json::Value::Array(vec![])),
        )
        .context("failed to parse resources/list response")?;
        Ok(resources)
    }

    /// Read a resource.
    pub async fn read_resource(&mut self, uri: &str) -> anyhow::Result<serde_json::Value> {
        let params = serde_json::json!({
            "uri": uri,
        });
        let result = self.send_request("resources/read", params).await?;
        Ok(result)
    }

    /// Get the discovered tool list.
    pub fn tools(&self) -> &[McpToolInfo] {
        &self.tools
    }

    /// Get the server name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Shutdown the server gracefully.
    pub async fn shutdown(&mut self) -> anyhow::Result<()> {
        // Close stdin to signal the server to exit
        self.stdin.shutdown().await?;
        // Wait for the process to exit (with a reasonable timeout)
        match tokio::time::timeout(std::time::Duration::from_secs(5), self.process.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(_)) => {
                // Process may have already exited; not a fatal error.
                Ok(())
            }
            Err(_) => {
                // Timeout — kill the process
                let _ = self.process.kill().await;
                Ok(())
            }
        }
    }

    // -- Internal helpers -----------------------------------------------------

    /// Send a JSON-RPC request and read the response.
    async fn send_request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        let id = self.next_id;
        self.next_id += 1;

        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: method.to_string(),
            params,
        };

        let mut line = serde_json::to_string(&request)?;
        line.push('\n');

        self.stdin
            .write_all(line.as_bytes())
            .await
            .with_context(|| format!("failed to write request to MCP server ({method})"))?;
        self.stdin.flush().await?;

        // Read the response line
        let mut response_line = String::new();
        self.stdout
            .read_line(&mut response_line)
            .await
            .with_context(|| format!("failed to read response from MCP server ({method})"))?;

        let response_line = response_line.trim();
        if response_line.is_empty() {
            bail!("empty response from MCP server for {method}");
        }

        let response: JsonRpcResponse = serde_json::from_str(response_line)
            .with_context(|| format!("invalid JSON-RPC response for {method}"))?;

        if let Some(error) = response.error {
            bail!(
                "MCP server error for {method}: [{}] {}",
                error.code,
                error.message
            );
        }

        response
            .result
            .ok_or_else(|| anyhow!("MCP server returned neither result nor error for {method}"))
    }

    /// Send a JSON-RPC notification (no id, no response expected).
    async fn send_notification(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<()> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });

        let mut line = serde_json::to_string(&notification)?;
        line.push('\n');

        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// MCP Manager
// ---------------------------------------------------------------------------

/// Manages multiple MCP server connections.
pub struct McpManager {
    clients: HashMap<String, McpClient>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    /// Connect to a server from config.
    pub async fn connect(&mut self, name: String, config: &McpServerConfig) -> anyhow::Result<()> {
        let client = McpClient::connect(name.clone(), config).await?;
        self.clients.insert(name, client);
        Ok(())
    }

    /// Call a tool by its MCP-namespaced name (format: "mcp__{server}__{tool}").
    pub async fn call_tool(
        &mut self,
        namespaced_name: &str,
        arguments: serde_json::Value,
    ) -> anyhow::Result<McpToolResult> {
        let (server, tool) = parse_mcp_tool_name(namespaced_name)
            .ok_or_else(|| anyhow!("invalid MCP tool name: {namespaced_name}"))?;

        let client = self
            .clients
            .get_mut(server)
            .ok_or_else(|| anyhow!("no MCP server connected with name: {server}"))?;

        client.call_tool(tool, arguments).await
    }

    /// List all tools from all connected servers, with namespaced names.
    pub fn all_tools(&self) -> Vec<(String, McpToolInfo)> {
        let mut result = Vec::new();
        for (server_name, client) in &self.clients {
            for tool in client.tools() {
                let namespaced = format!("mcp__{server_name}__{}", tool.name);
                result.push((namespaced, tool.clone()));
            }
        }
        result
    }

    /// Check if a namespaced tool name belongs to any connected server.
    pub fn has_tool(&self, namespaced_name: &str) -> bool {
        let Some((server, tool)) = parse_mcp_tool_name(namespaced_name) else {
            return false;
        };
        self.clients
            .get(server)
            .is_some_and(|c| c.tools().iter().any(|t| t.name == tool))
    }

    /// Shutdown all servers.
    pub async fn shutdown_all(&mut self) {
        for client in self.clients.values_mut() {
            let _ = client.shutdown().await;
        }
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Name parsing helper
// ---------------------------------------------------------------------------

/// Parse "mcp__{server}__{tool}" into (server, tool).
/// Returns `None` if the format does not match.
pub fn parse_mcp_tool_name(namespaced_name: &str) -> Option<(&str, &str)> {
    let rest = namespaced_name.strip_prefix("mcp__")?;
    let sep = rest.find("__")?;
    let server = &rest[..sep];
    let tool = &rest[sep + 2..];
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some((server, tool))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -- McpServerConfig deserialization --

    #[test]
    fn mcp_server_config_deserialization_minimal() {
        let config: McpServerConfig =
            serde_json::from_str(r#"{"command": "npx", "args": ["-y", "server"]}"#).unwrap();
        assert_eq!(config.command, "npx");
        assert_eq!(config.args, vec!["-y", "server"]);
        assert!(config.env.is_empty());
    }

    #[test]
    fn mcp_server_config_deserialization_with_env() {
        let config: McpServerConfig = serde_json::from_str(
            r#"{"command": "node", "args": ["server.js"], "env": {"FOO": "bar"}}"#,
        )
        .unwrap();
        assert_eq!(config.command, "node");
        assert_eq!(config.env["FOO"], "bar");
    }

    #[test]
    fn mcp_server_config_defaults() {
        let config: McpServerConfig = serde_json::from_str(r#"{"command": "my-server"}"#).unwrap();
        assert!(config.args.is_empty());
        assert!(config.env.is_empty());
    }

    // -- Namespaced tool name parsing --

    #[test]
    fn parse_valid_mcp_tool_name() {
        let (server, tool) = parse_mcp_tool_name("mcp__myserver__read_file").unwrap();
        assert_eq!(server, "myserver");
        assert_eq!(tool, "read_file");
    }

    #[test]
    fn parse_mcp_tool_name_with_dashes() {
        let (server, tool) = parse_mcp_tool_name("mcp__my-server__my-tool").unwrap();
        assert_eq!(server, "my-server");
        assert_eq!(tool, "my-tool");
    }

    #[test]
    fn parse_mcp_tool_name_rejects_no_prefix() {
        assert!(parse_mcp_tool_name("read_file").is_none());
    }

    #[test]
    fn parse_mcp_tool_name_rejects_wrong_prefix() {
        assert!(parse_mcp_tool_name("mcp_read_file").is_none());
    }

    #[test]
    fn parse_mcp_tool_name_rejects_empty_server() {
        assert!(parse_mcp_tool_name("mcp____tool").is_none());
    }

    #[test]
    fn parse_mcp_tool_name_rejects_empty_tool() {
        assert!(parse_mcp_tool_name("mcp__server__").is_none());
    }

    #[test]
    fn parse_mcp_tool_name_rejects_only_mcp() {
        assert!(parse_mcp_tool_name("mcp__").is_none());
    }

    // -- McpManager::has_tool --

    #[test]
    fn mcp_manager_has_tool_with_no_clients() {
        let manager = McpManager::new();
        assert!(!manager.has_tool("mcp__server__tool"));
    }

    #[test]
    fn mcp_manager_has_tool_invalid_name() {
        let manager = McpManager::new();
        assert!(!manager.has_tool("not_mcp_tool"));
    }

    // -- McpToolResult deserialization --

    #[test]
    fn mcp_tool_result_text_content() {
        let result: McpToolResult = serde_json::from_str(
            r#"{"content": [{"type": "text", "text": "hello world"}], "isError": false}"#,
        )
        .unwrap();
        assert!(!result.is_error);
        assert_eq!(result.content.len(), 1);
        match &result.content[0] {
            McpContentBlock::Text { text } => assert_eq!(text, "hello world"),
            other => panic!("expected Text block, got {other:?}"),
        }
    }

    #[test]
    fn mcp_tool_result_image_content() {
        let result: McpToolResult = serde_json::from_str(
            r#"{"content": [{"type": "image", "data": "base64data", "mimeType": "image/png"}], "isError": true}"#,
        )
        .unwrap();
        assert!(result.is_error);
        assert_eq!(result.content.len(), 1);
        match &result.content[0] {
            McpContentBlock::Image { data, mime_type } => {
                assert_eq!(data, "base64data");
                assert_eq!(mime_type, "image/png");
            }
            other => panic!("expected Image block, got {other:?}"),
        }
    }

    #[test]
    fn mcp_tool_result_mixed_content() {
        let result: McpToolResult = serde_json::from_str(
            r#"{"content": [
                {"type": "text", "text": "here is the image:"},
                {"type": "image", "data": "abc123", "mimeType": "image/jpeg"}
            ]}"#,
        )
        .unwrap();
        assert!(!result.is_error);
        assert_eq!(result.content.len(), 2);
    }

    #[test]
    fn mcp_tool_result_empty_content() {
        let result: McpToolResult = serde_json::from_str(r#"{"content": []}"#).unwrap();
        assert!(result.content.is_empty());
        assert!(!result.is_error);
    }

    // -- McpContentBlock deserialization --

    #[test]
    fn mcp_content_block_text() {
        let block: McpContentBlock =
            serde_json::from_str(r#"{"type": "text", "text": "hello"}"#).unwrap();
        match block {
            McpContentBlock::Text { text } => assert_eq!(text, "hello"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn mcp_content_block_image() {
        let block: McpContentBlock =
            serde_json::from_str(r#"{"type": "image", "data": "AAAA", "mimeType": "image/png"}"#)
                .unwrap();
        match block {
            McpContentBlock::Image { data, mime_type } => {
                assert_eq!(data, "AAAA");
                assert_eq!(mime_type, "image/png");
            }
            _ => panic!("expected Image"),
        }
    }

    // -- JSON-RPC request building --

    #[test]
    fn json_rpc_request_structure() {
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id: 42,
            method: "tools/call".to_string(),
            params: json!({"name": "read", "arguments": {"path": "/tmp"}}),
        };

        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(value["jsonrpc"], "2.0");
        assert_eq!(value["id"], 42);
        assert_eq!(value["method"], "tools/call");
        assert_eq!(value["params"]["name"], "read");
        assert_eq!(value["params"]["arguments"]["path"], "/tmp");
    }

    #[test]
    fn json_rpc_response_with_result() {
        let response: JsonRpcResponse =
            serde_json::from_str(r#"{"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}"#)
                .unwrap();
        assert!(response.result.is_some());
        assert!(response.error.is_none());
        let result = response.result.unwrap();
        assert!(result["tools"].is_array());
    }

    #[test]
    fn json_rpc_response_with_error() {
        let response: JsonRpcResponse = serde_json::from_str(
            r#"{"jsonrpc": "2.0", "id": 1, "error": {"code": -32600, "message": "Invalid Request"}}"#,
        )
        .unwrap();
        assert!(response.result.is_none());
        let error = response.error.unwrap();
        assert_eq!(error.code, -32600);
        assert_eq!(error.message, "Invalid Request");
    }

    // -- McpResource deserialization --

    #[test]
    fn mcp_resource_deserialization() {
        let resource: McpResource = serde_json::from_str(
            r#"{"uri": "file:///tmp/test.txt", "name": "test", "description": "a test file", "mimeType": "text/plain"}"#,
        )
        .unwrap();
        assert_eq!(resource.uri, "file:///tmp/test.txt");
        assert_eq!(resource.name, "test");
        assert_eq!(resource.description.as_deref(), Some("a test file"));
        assert_eq!(resource.mime_type.as_deref(), Some("text/plain"));
    }

    #[test]
    fn mcp_resource_minimal() {
        let resource: McpResource =
            serde_json::from_str(r#"{"uri": "file:///x", "name": "x"}"#).unwrap();
        assert!(resource.description.is_none());
        assert!(resource.mime_type.is_none());
    }

    // -- McpToolInfo deserialization --

    #[test]
    fn mcp_tool_info_full() {
        let info: McpToolInfo = serde_json::from_str(
            r#"{"name": "read_file", "description": "Read a file", "inputSchema": {"type": "object"}}"#,
        )
        .unwrap();
        assert_eq!(info.name, "read_file");
        assert_eq!(info.description.as_deref(), Some("Read a file"));
        assert!(info.input_schema.is_some());
    }

    #[test]
    fn mcp_tool_info_minimal() {
        let info: McpToolInfo = serde_json::from_str(r#"{"name": "tool"}"#).unwrap();
        assert!(info.description.is_none());
        assert!(info.input_schema.is_none());
    }

    // -- McpManager::all_tools (with manually populated state) --

    // We cannot easily create McpClient without spawning a process, so we test
    // all_tools indirectly by verifying that an empty manager returns nothing.
    #[test]
    fn mcp_manager_all_tools_empty() {
        let manager = McpManager::new();
        assert!(manager.all_tools().is_empty());
    }

    #[test]
    fn mcp_manager_default_is_new() {
        let manager = McpManager::default();
        assert!(manager.all_tools().is_empty());
    }
}
