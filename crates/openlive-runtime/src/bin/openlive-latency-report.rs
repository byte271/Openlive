use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader},
    path::PathBuf,
};

use clap::Parser;
use openlive_protocol::{EventEnvelope, LatencyPhase, RealtimeEvent};
use serde_json::json;

#[derive(Debug, Parser)]
#[command(name = "openlive-latency-report")]
struct Args {
    #[arg(value_name = "JSONL")]
    input: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let reader = BufReader::new(File::open(&args.input)?);
    let mut samples: BTreeMap<LatencyPhase, Vec<u64>> = BTreeMap::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event = serde_json::from_str::<EventEnvelope>(&line)?;
        if let RealtimeEvent::LatencyMark(mark) = event.event {
            samples.entry(mark.phase).or_default().push(mark.elapsed_us);
        }
    }

    let mut report = serde_json::Map::new();
    for (phase, mut values) in samples {
        values.sort_unstable();
        let phase_name = serde_json::to_value(phase)?
            .as_str()
            .ok_or("latency phase did not serialize as a string")?
            .to_owned();
        report.insert(
            phase_name,
            json!({
                "count": values.len(),
                "min_ms": to_ms(values[0]),
                "p50_ms": to_ms(percentile(&values, 50)),
                "p95_ms": to_ms(percentile(&values, 95)),
                "max_ms": to_ms(*values.last().ok_or("empty latency sample")?),
            }),
        );
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn percentile(values: &[u64], percentile: usize) -> u64 {
    let index = values.len().saturating_mul(percentile).saturating_add(99) / 100;
    let index = index.saturating_sub(1).min(values.len().saturating_sub(1));
    values[index]
}

#[allow(clippy::cast_precision_loss)]
fn to_ms(microseconds: u64) -> f64 {
    microseconds as f64 / 1_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_uses_nearest_rank_index() {
        let values = [10, 20, 30, 40, 50];
        assert_eq!(percentile(&values, 50), 30);
        assert_eq!(percentile(&values, 95), 50);
    }
}
