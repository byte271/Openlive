use std::{
    fs::File,
    io::{BufRead, BufReader, BufWriter, Write},
    path::PathBuf,
};

use clap::Parser;
use openlive_protocol::{EventEnvelope, InteractionProfile};
use openlive_runtime::{replay, ChronosConfig};

#[derive(Debug, Parser)]
#[command(name = "openlive-replay")]
struct Args {
    #[arg(value_name = "JSONL")]
    input: PathBuf,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let reader = BufReader::new(File::open(&args.input)?);
    let mut events = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        events.push(serde_json::from_str::<EventEnvelope>(&line)?);
    }
    let first = events.first().ok_or("replay file contains no events")?;
    let output = replay(
        first.session_id,
        ChronosConfig::default(),
        InteractionProfile::default(),
        &events,
    )?;

    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    for event in output {
        serde_json::to_writer(&mut writer, &event)?;
        writer.write_all(b"\n")?;
    }
    writer.flush()?;
    Ok(())
}
