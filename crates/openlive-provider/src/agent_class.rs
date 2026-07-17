//! Agent classes: tool allow-lists + memory slice tags.

use serde::{Deserialize, Serialize};

/// Product agent roles (tool budgets differ).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentClass {
    /// Full tool surface (default).
    #[default]
    General,
    /// Research-only: search / browse / pool — no sandbox writes.
    Researcher,
    /// Files + calc — no web search pool.
    Coder,
    /// Read-only helpers: time, calc, identity, list/read files.
    Safe,
}

impl AgentClass {
    #[must_use]
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "researcher" | "research" => Self::Researcher,
            "coder" | "code" | "dev" => Self::Coder,
            "safe" | "readonly" | "read_only" => Self::Safe,
            _ => Self::General,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Researcher => "researcher",
            Self::Coder => "coder",
            Self::Safe => "safe",
        }
    }

    /// Memory tags applied when this class writes durable memory.
    #[must_use]
    pub fn memory_tags(self) -> Vec<String> {
        vec!["agent".into(), self.as_str().into()]
    }

    /// Tools this class may invoke. Empty deny = allow all known tools.
    #[must_use]
    pub fn allowed_tools(self) -> &'static [&'static str] {
        match self {
            Self::General => &[
                "web_search",
                "deep_search",
                "research_pool",
                "browse_url",
                "browse_site",
                "screenshot_url",
                "print_pdf",
                "save_note",
                "get_profile",
                "remember_fact",
                "get_time",
                "calculator",
                "list_files",
                "read_file",
                "write_file",
                "delete_file",
            ],
            Self::Researcher => &[
                "web_search",
                "deep_search",
                "research_pool",
                "browse_url",
                "browse_site",
                "screenshot_url",
                "print_pdf",
                "save_note",
                "get_profile",
                "remember_fact",
                "get_time",
            ],
            Self::Coder => &[
                "calculator",
                "get_time",
                "list_files",
                "read_file",
                "write_file",
                "delete_file",
                "save_note",
                "get_profile",
                "remember_fact",
            ],
            Self::Safe => &[
                "get_time",
                "calculator",
                "list_files",
                "read_file",
                "get_profile",
            ],
        }
    }

    #[must_use]
    pub fn allows(self, tool: &str) -> bool {
        self.allowed_tools().contains(&tool)
    }

    #[must_use]
    pub fn catalog() -> Vec<serde_json::Value> {
        use serde_json::json;
        [Self::General, Self::Researcher, Self::Coder, Self::Safe]
            .into_iter()
            .map(|c| {
                json!({
                    "id": c.as_str(),
                    "tools": c.allowed_tools(),
                    "memory_tags": c.memory_tags(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_blocks_write() {
        assert!(!AgentClass::Safe.allows("write_file"));
        assert!(AgentClass::Safe.allows("read_file"));
    }

    #[test]
    fn researcher_blocks_files() {
        assert!(!AgentClass::Researcher.allows("write_file"));
        assert!(AgentClass::Researcher.allows("web_search"));
    }
}
