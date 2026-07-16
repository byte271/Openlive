//! Lightweight full-duplex timing bench for OpenLive.
//!
//! Measures local Chronos endpointing + decision overhead without network.
//! Useful as a regression gate until full VoiceBench datasets are wired.
//!
//! ```text
//! cargo run -p openlive-runtime --release --bin openlive-full-duplex-bench -- --turns 50
//! ```

use std::time::Instant;

use clap::Parser;
use openlive_protocol::{
    EventEnvelope, InteractionAction, InteractionProfile, Observation, RealtimeEvent,
};
use openlive_runtime::{ChronosConfig, SessionEngine};
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(name = "openlive-full-duplex-bench")]
struct Args {
    /// Number of synthetic turns to run.
    #[arg(long, default_value_t = 50)]
    turns: usize,
}

fn main() {
    let args = Args::parse();
    let mut commit_latencies_ms = Vec::with_capacity(args.turns);
    let frame_us = 20_000_u64;

    let wall = Instant::now();
    for turn in 0..args.turns {
        // Fresh engine per turn — isolates commit latency from long-session state.
        let session_id = Uuid::new_v4();
        let mut engine = SessionEngine::new(
            session_id,
            ChronosConfig::default(),
            InteractionProfile::default(),
        );
        let mut sequence = 0_u64;
        let mut media_us = 0_u64;
        let turn_start = Instant::now();
        let mut committed = false;

        // Pattern mirrored from runtime unit tests: speech then rising silence finality.
        for _ in 0..15 {
            media_us += frame_us;
            sequence += 1;
            let _ = engine.process(&observation(
                session_id, sequence, media_us, 0.9, 0.2, 0.2, None,
            ));
        }
        // Jump media time like the unit test (~600 ms+ of silence).
        for (i, conf) in [0.7_f32, 0.8, 0.85, 0.9].iter().enumerate() {
            media_us += 300_000;
            sequence += 1;
            let semantic = if i >= 2 { Some(0.95) } else { None };
            if let Ok(decisions) = engine.process(&observation(
                session_id, sequence, media_us, 0.1, *conf, *conf, semantic,
            )) {
                if decisions.iter().any(|e| {
                    matches!(
                        &e.event,
                        RealtimeEvent::InteractionDecision(d)
                            if d.action == InteractionAction::StartResponse
                    )
                }) {
                    committed = true;
                    break;
                }
            }
        }

        commit_latencies_ms.push(turn_start.elapsed().as_secs_f64() * 1000.0);
        if !committed {
            eprintln!("warn: turn {turn} did not emit StartResponse");
        }
    }

    commit_latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = percentile(&commit_latencies_ms, 0.50);
    let p95 = percentile(&commit_latencies_ms, 0.95);
    let max = commit_latencies_ms.last().copied().unwrap_or(0.0);
    let total_ms = wall.elapsed().as_secs_f64() * 1000.0;

    println!("openlive-full-duplex-bench");
    println!("  turns:        {}", args.turns);
    println!("  wall_ms:      {total_ms:.2}");
    println!("  commit_p50:   {p50:.3} ms");
    println!("  commit_p95:   {p95:.3} ms");
    println!("  commit_max:   {max:.3} ms");
    println!("  gate:         p50 ≤ 5 ms, p95 ≤ 20 ms (local Chronos only)");

    if p50 > 5.0 || p95 > 20.0 {
        eprintln!("FAIL: latency gate exceeded");
        std::process::exit(1);
    }
    println!("  result:       PASS");
}

fn observation(
    session_id: Uuid,
    sequence: u64,
    media_time_us: u64,
    speech: f32,
    turn_completion: f32,
    prosody: f32,
    semantic: Option<f32>,
) -> EventEnvelope {
    EventEnvelope::new(
        session_id,
        "bench",
        sequence,
        media_time_us,
        RealtimeEvent::Observation(Observation {
            speech_probability: speech,
            echo_probability: 0.0,
            target_speaker_probability: speech,
            turn_completion_confidence: turn_completion,
            prosodic_finality: prosody,
            semantic_completion: semantic,
        }),
    )
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}
