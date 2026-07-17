//! Live multi-agent pool job status (in-memory).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent_client::AgentClient;
use crate::agent_pool::{PoolAgentResult, PoolRequest, PoolResult, MAX_AGENTS};

const TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolJobStatus {
    pub pool_id: String,
    pub status: String, // queued | running | completed | error
    pub total: usize,
    pub completed: usize,
    pub intent: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub partial: Vec<PoolAgentResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synthesis: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct JobEntry {
    status: PoolJobStatus,
    created: Instant,
}

fn jobs() -> &'static Mutex<HashMap<String, JobEntry>> {
    static J: OnceLock<Mutex<HashMap<String, JobEntry>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

fn purge(map: &mut HashMap<String, JobEntry>) {
    map.retain(|_, e| e.created.elapsed() < TTL);
}

#[must_use]
pub fn get_status(id: &str) -> Option<PoolJobStatus> {
    let mut g = jobs().lock().ok()?;
    purge(&mut g);
    g.get(id).map(|e| e.status.clone())
}

/// Start a pool job in the background; returns immediately with `pool_id`.
/// Clients open SSE `/v1/agent/pool/events?id=` for live progress.
#[must_use]
pub fn start_pool_job(agent: AgentClient, req: PoolRequest, use_llm: bool) -> PoolJobStatus {
    let pool_id = Uuid::new_v4().to_string();
    let max = req.max_agents.unwrap_or(4).clamp(1, MAX_AGENTS);
    let intent = req.intent.clone();
    let initial = PoolJobStatus {
        pool_id: pool_id.clone(),
        status: "running".into(),
        total: max,
        completed: 0,
        intent: intent.clone(),
        partial: vec![],
        synthesis: None,
        error: None,
    };
    if let Ok(mut g) = jobs().lock() {
        purge(&mut g);
        g.insert(
            pool_id.clone(),
            JobEntry {
                status: initial.clone(),
                created: Instant::now(),
            },
        );
    }

    let id = pool_id.clone();
    tokio::spawn(async move {
        let _ = run_pool_tracked_with_id(&agent, req, use_llm, &id).await;
    });

    initial
}

/// Run that publishes a job id with live partials during execution.
pub async fn run_pool_tracked(
    agent: &AgentClient,
    _http: &reqwest::Client,
    req: PoolRequest,
    use_llm: bool,
) -> PoolResult {
    let pool_id = Uuid::new_v4().to_string();
    run_pool_tracked_with_id(agent, req, use_llm, &pool_id).await
}

async fn run_pool_tracked_with_id(
    agent: &AgentClient,
    req: PoolRequest,
    use_llm: bool,
    pool_id: &str,
) -> PoolResult {
    use crate::agent_pool::derive_angles;
    use crate::tools::web_search;
    use futures_util::stream::{self, StreamExt};

    let max = req.max_agents.unwrap_or(4).clamp(1, MAX_AGENTS);
    let depth = req
        .thought_depth
        .clone()
        .unwrap_or_else(|| "balanced".into());
    let parent = req.intent.clone();

    let tasks: Vec<(usize, String)> = if req.tasks.is_empty() {
        derive_angles(&parent, max)
            .into_iter()
            .enumerate()
            .collect()
    } else {
        req.tasks
            .into_iter()
            .take(max)
            .enumerate()
            .map(|(i, t)| (i, t.intent))
            .collect()
    };
    let total = tasks.len();

    if let Ok(mut g) = jobs().lock() {
        purge(&mut g);
        g.insert(
            pool_id.to_owned(),
            JobEntry {
                status: PoolJobStatus {
                    pool_id: pool_id.to_owned(),
                    status: "running".into(),
                    total,
                    completed: 0,
                    intent: parent.clone(),
                    partial: vec![],
                    synthesis: None,
                    error: None,
                },
                created: Instant::now(),
            },
        );
    }

    let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let pool_id_c = pool_id.to_owned();
    // Reuse the agent's HTTP client via web_search — agent has private http; use local.
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(25))
        .build()
        .unwrap_or_default();

    let results: Vec<PoolAgentResult> = stream::iter(tasks)
        .map(|(index, intent)| {
            let completed = Arc::clone(&completed);
            let pool_id = pool_id_c.clone();
            let depth = depth.clone();
            let http = http.clone();
            async move {
                let out = if use_llm {
                    let r = agent
                        .run(crate::agent_client::AgentRequest {
                            kind: crate::agent_client::AgentKind::Internal,
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
                    match web_search(&http, &q).await {
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
                let n = completed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if let Ok(mut g) = jobs().lock() {
                    if let Some(entry) = g.get_mut(&pool_id) {
                        entry.status.completed = n;
                        entry.status.partial.push(out.clone());
                        entry.status.partial.sort_by_key(|r| r.index);
                    }
                }
                out
            }
        })
        .buffer_unordered(max.min(8))
        .collect()
        .await;

    let mut ordered = results;
    ordered.sort_by_key(|r| r.index);
    let synthesis = synthesize(&parent, &ordered);
    let ok = ordered
        .iter()
        .any(|r| r.status == "completed" && r.result.is_some());
    let status = if ok { "completed" } else { "error" };

    if let Ok(mut g) = jobs().lock() {
        if let Some(entry) = g.get_mut(pool_id) {
            entry.status.status = status.into();
            entry.status.completed = ordered.iter().filter(|r| r.status == "completed").count();
            entry.status.partial.clone_from(&ordered);
            entry.status.synthesis.clone_from(&synthesis);
            if !ok {
                entry.status.error = Some("one or more agents failed".into());
            }
        }
    }

    PoolResult {
        pool_id: pool_id.to_owned(),
        status: status.into(),
        agents_run: total,
        max_agents: max,
        results: ordered,
        synthesis,
    }
}

fn synthesize(parent: &str, results: &[PoolAgentResult]) -> Option<String> {
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
