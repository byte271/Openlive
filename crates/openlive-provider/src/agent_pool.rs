//! Multi-agent worker pool — up to 50 concurrent research/tool agents.
//! Each agent gets a focused sub-intent; results are merged for the caller.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::agent_client::{AgentClient, AgentKind, AgentRequest};
use crate::tools::web_search;

/// Hard cap (product requirement ≤50 concurrent agents).
pub const MAX_AGENTS: usize = 50;

/// Default concurrency for a single research job.
pub const DEFAULT_POOL_SIZE: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolTask {
    pub intent: String,
    #[serde(default)]
    pub thought_depth: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolRequest {
    /// Parent research question (used for final synthesis framing).
    pub intent: String,
    /// Explicit sub-tasks. If empty, the pool derives angles from `intent`.
    #[serde(default)]
    pub tasks: Vec<PoolTask>,
    /// How many agents to run (clamped `1..=MAX_AGENTS`).
    #[serde(default)]
    pub max_agents: Option<usize>,
    #[serde(default)]
    pub thought_depth: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolAgentResult {
    pub index: usize,
    pub intent: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools_used: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolResult {
    pub pool_id: String,
    pub status: String,
    pub agents_run: usize,
    pub max_agents: usize,
    pub results: Vec<PoolAgentResult>,
    /// Merged spoken-friendly answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synthesis: Option<String>,
}

/// Derive focused research angles from a parent question.
#[must_use]
pub fn derive_angles(intent: &str, n: usize) -> Vec<String> {
    let q = intent.trim();
    let n = n.clamp(1, MAX_AGENTS);
    let mut angles = vec![
        format!("search {q}"),
        format!("search {q} overview definition"),
        format!("search {q} examples use cases"),
        format!("search {q} history background"),
        format!("search {q} vs alternatives comparison"),
        format!("search {q} latest news"),
    ];
    angles.truncate(n);
    while angles.len() < n {
        let i = angles.len() + 1;
        angles.push(format!("search {q} aspect {i}"));
    }
    angles
}

/// Run a concurrent agent pool.
/// Fast path (`use_llm = false`): pure `web_search` workers.
/// Full path (`use_llm = true`): each worker runs the full `AgentClient` loop.
pub async fn run_pool(
    agent: &AgentClient,
    http: &reqwest::Client,
    req: PoolRequest,
    use_llm: bool,
) -> PoolResult {
    let pool_id = uuid::Uuid::new_v4().to_string();
    let max = req
        .max_agents
        .unwrap_or(DEFAULT_POOL_SIZE)
        .clamp(1, MAX_AGENTS);
    let depth = req
        .thought_depth
        .clone()
        .unwrap_or_else(|| "balanced".into());
    let parent = req.intent.clone();

    let tasks: Vec<PoolTask> = if req.tasks.is_empty() {
        derive_angles(&parent, max)
            .into_iter()
            .map(|intent| PoolTask {
                intent,
                thought_depth: Some(depth.clone()),
            })
            .collect()
    } else {
        req.tasks.into_iter().take(max).collect()
    };

    let agents_run = tasks.len();
    let active = Arc::new(AtomicUsize::new(0));
    let depth_for_workers = depth.clone();

    let results: Vec<PoolAgentResult> = stream::iter(tasks.into_iter().enumerate())
        .map(|(index, task)| {
            let active = Arc::clone(&active);
            let depth = task
                .thought_depth
                .clone()
                .unwrap_or_else(|| depth_for_workers.clone());
            let intent = task.intent.clone();
            async move {
                active.fetch_add(1, Ordering::SeqCst);
                let out = if use_llm {
                    let r = agent
                        .run(AgentRequest {
                            kind: AgentKind::Internal,
                            intent: intent.clone(),
                            base_url: None,
                            api_key: None,
                            model: None,
                            thought_depth: Some(depth),
                            agent_class: Some("researcher".into()),
                            session_id: None,
                            prior_context: None,
                        })
                        .await;
                    PoolAgentResult {
                        index,
                        intent,
                        status: r.status,
                        result: r.result,
                        error: r.error,
                        tools_used: r.tools_used,
                    }
                } else {
                    let q = intent
                        .trim()
                        .trim_start_matches("search ")
                        .trim_start_matches("Search ")
                        .to_owned();
                    match web_search(http, &q).await {
                        Ok(text) => PoolAgentResult {
                            index,
                            intent,
                            status: "completed".into(),
                            result: Some(text),
                            error: None,
                            tools_used: vec!["web_search".into()],
                        },
                        Err(e) => PoolAgentResult {
                            index,
                            intent,
                            status: "error".into(),
                            result: None,
                            error: Some(e),
                            tools_used: vec!["web_search".into()],
                        },
                    }
                };
                active.fetch_sub(1, Ordering::SeqCst);
                out
            }
        })
        .buffer_unordered(max.min(8))
        .collect()
        .await;

    let mut ordered = results;
    ordered.sort_by_key(|r| r.index);

    let synthesis = synthesize_results(&parent, &ordered);
    let ok = ordered
        .iter()
        .any(|r| r.status == "completed" && r.result.is_some());

    PoolResult {
        pool_id,
        status: if ok {
            "completed".into()
        } else {
            "error".into()
        },
        agents_run,
        max_agents: max,
        results: ordered,
        synthesis,
    }
}

fn synthesize_results(parent: &str, results: &[PoolAgentResult]) -> Option<String> {
    let mut chunks: Vec<String> = results
        .iter()
        .filter_map(|r| r.result.as_ref())
        .map(|t| {
            let line = t.lines().next().unwrap_or(t).trim();
            line.chars().take(220).collect::<String>()
        })
        .filter(|s| s.len() > 12)
        .collect();
    chunks.dedup();
    if chunks.is_empty() {
        return None;
    }
    chunks.truncate(4);
    let body = chunks.join(" ");
    let prefix = if parent
        .chars()
        .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
    {
        format!("关于「{parent}」：")
    } else {
        format!("On “{parent}”: ")
    };
    Some(format!(
        "{}{}",
        prefix,
        body.chars().take(700).collect::<String>()
    ))
}

/// Status snapshot for health/meta.
#[must_use]
pub fn pool_limits() -> serde_json::Value {
    json!({
        "max_agents": MAX_AGENTS,
        "default_pool_size": DEFAULT_POOL_SIZE,
        "modes": ["search_workers", "llm_agents"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_clamped_angles() {
        let a = derive_angles("what is an agent", 3);
        assert_eq!(a.len(), 3);
        assert!(a[0].contains("agent"));
    }

    #[test]
    fn caps_at_max() {
        let a = derive_angles("x", 100);
        assert_eq!(a.len(), MAX_AGENTS);
    }
}
