//! Minimal MCP (Model Context Protocol) JSON-RPC client over HTTP.
//!
//! Speaks a practical subset used by remote tool hosts:
//! - `tools/list`
//! - `tools/call`
//!
//! Transport: `POST {base_url}` with JSON-RPC 2.0 body. Compatible with many
//! HTTP MCP bridges and LocalAI-style tool gateways. Does **not** implement
//! the full MCP SSE/stdio surface — that can layer on later.
//!
//! Spec inspiration: Anthropic MCP (open protocol). This file is original
//! OpenLive code.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum McpError {
    #[error("mcp http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("mcp rpc error: {0}")]
    Rpc(String),
    #[error("mcp configuration: {0}")]
    Config(String),
}

#[derive(Debug)]
pub struct McpClient {
    base_url: String,
    api_key: Option<String>,
    client: Client,
    next_id: std::sync::atomic::AtomicU64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpToolResult {
    pub content: Value,
    #[serde(default)]
    pub is_error: bool,
}

impl McpClient {
    /// # Errors
    /// Returns when the base URL is empty or the HTTP client fails to build.
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Result<Self, McpError> {
        let base_url = base_url.into();
        if base_url.trim().is_empty() {
            return Err(McpError::Config("base_url cannot be empty".into()));
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(McpError::Http)?;
        Ok(Self {
            base_url,
            api_key,
            client,
            next_id: std::sync::atomic::AtomicU64::new(1),
        })
    }

    /// List tools advertised by the remote MCP server.
    ///
    /// # Errors
    /// Returns on network or RPC failures.
    pub async fn list_tools(&self) -> Result<Vec<McpTool>, McpError> {
        let result = self.rpc("tools/list", json!({})).await?;
        // Accept `{ tools: [...] }` or bare array.
        let tools_value = result
            .get("tools")
            .cloned()
            .unwrap_or(result);
        let tools: Vec<McpTool> = serde_json::from_value(tools_value).map_err(|error| {
            McpError::Rpc(format!("invalid tools/list payload: {error}"))
        })?;
        Ok(tools)
    }

    /// Invoke a named tool with JSON arguments.
    ///
    /// # Errors
    /// Returns on network or RPC failures.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<McpToolResult, McpError> {
        let result = self
            .rpc(
                "tools/call",
                json!({
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await?;
        if let Ok(parsed) = serde_json::from_value::<McpToolResult>(result.clone()) {
            return Ok(parsed);
        }
        Ok(McpToolResult {
            content: result,
            is_error: false,
        })
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut request = self.client.post(&self.base_url).json(&body);
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            return Err(McpError::Rpc(format!(
                "HTTP {} from MCP server",
                response.status()
            )));
        }
        let payload: Value = response.json().await?;
        if let Some(error) = payload.get("error") {
            return Err(McpError::Rpc(error.to_string()));
        }
        payload
            .get("result")
            .cloned()
            .ok_or_else(|| McpError::Rpc("missing result field".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_url() {
        assert!(McpClient::new("", None).is_err());
    }

    #[test]
    fn builds_with_url() {
        let client = McpClient::new("http://127.0.0.1:9/mcp", None).expect("client");
        assert!(!client.base_url.is_empty());
    }
}
