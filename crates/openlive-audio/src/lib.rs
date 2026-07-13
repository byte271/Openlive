use openlive_protocol::{EndpointingPrediction, PcmAudioFrame};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioAnalysis {
    pub speech_probability: f32,
    pub echo_probability: f32,
    pub target_speaker_probability: f32,
    pub rms: f32,
}

#[derive(Debug)]
pub struct AcousticFrontend {
    noise_floor_rms: f32,
}

impl Default for AcousticFrontend {
    fn default() -> Self {
        Self {
            noise_floor_rms: 0.006,
        }
    }
}

impl AcousticFrontend {
    /// Validates and analyzes one mono PCM16 input frame.
    ///
    /// # Errors
    ///
    /// Returns an error for unsupported audio metadata or a PCM payload whose
    /// byte length does not match its declared duration.
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    pub fn analyze(
        &mut self,
        frame: &PcmAudioFrame,
        assistant_playout_active: bool,
    ) -> Result<AudioAnalysis, String> {
        validate_frame(frame)?;
        let expected = expected_pcm_bytes(frame);
        if frame.pcm.len() != expected {
            return Err(format!(
                "PCM length mismatch: expected {expected} bytes, received {}",
                frame.pcm.len()
            ));
        }

        let rms = pcm_rms(&frame.pcm);
        let client_probability = frame
            .client_speech_probability
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        let output_level = frame.client_output_level.unwrap_or(0.0).clamp(0.0, 1.0);
        if !assistant_playout_active && client_probability < 0.25 {
            self.noise_floor_rms = self.noise_floor_rms.mul_add(0.985, rms * 0.015);
        }
        let ratio = rms / self.noise_floor_rms.max(0.001);
        let server_probability = ((ratio - 1.8) / 5.5).clamp(0.0, 1.0);
        let raw_speech_probability = if frame.client_speech_probability.is_some() {
            server_probability.mul_add(0.45, client_probability * 0.55)
        } else {
            server_probability
        };
        let server_echo_probability = estimate_echo_probability(
            assistant_playout_active,
            output_level,
            rms,
            server_probability,
            client_probability,
        );
        let echo_probability = frame
            .client_echo_probability
            .map_or(server_echo_probability, |client_echo| {
                server_echo_probability.mul_add(0.35, client_echo.clamp(0.0, 1.0) * 0.65)
            });
        let speech_probability =
            (raw_speech_probability * (1.0 - echo_probability * 0.72)).clamp(0.0, 1.0);
        let target_speaker_probability =
            (speech_probability * (1.0 - echo_probability)).clamp(0.0, 1.0);
        Ok(AudioAnalysis {
            speech_probability,
            echo_probability,
            target_speaker_probability,
            rms,
        })
    }
}

#[derive(Debug, Default)]
pub struct EndpointingTracker {
    speech_started_us: Option<u64>,
    silence_started_us: Option<u64>,
    speech_duration_ms: u32,
    silence_duration_ms: u32,
    previous_rms: f32,
    falling_energy_frames: u8,
}

impl EndpointingTracker {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    #[allow(clippy::cast_precision_loss)]
    pub fn observe(
        &mut self,
        media_time_us: u64,
        frame_duration_ms: u16,
        analysis: &AudioAnalysis,
    ) -> EndpointingPrediction {
        if analysis.speech_probability >= 0.62 {
            self.speech_started_us.get_or_insert(media_time_us);
            self.silence_started_us = None;
            self.silence_duration_ms = 0;
            self.speech_duration_ms = self
                .speech_duration_ms
                .saturating_add(u32::from(frame_duration_ms));
            self.update_energy_shape(analysis.rms);
            return EndpointingPrediction {
                speech_duration_ms: self.speech_duration_ms,
                silence_duration_ms: 0,
                turn_completion_confidence: 0.1,
                prosodic_finality: 0.1,
                should_respond: false,
                reason: "speech is active".to_owned(),
            };
        }
        if self.speech_started_us.is_none() {
            self.previous_rms = analysis.rms;
            return empty_prediction();
        }

        let silence_start = *self.silence_started_us.get_or_insert(media_time_us);
        self.silence_duration_ms =
            u32::try_from(media_time_us.saturating_sub(silence_start) / 1_000).unwrap_or(u32::MAX);
        self.update_energy_shape(analysis.rms);
        self.finality_prediction()
    }

    fn update_energy_shape(&mut self, rms: f32) {
        if rms < self.previous_rms * 0.82 {
            self.falling_energy_frames = self.falling_energy_frames.saturating_add(1).min(12);
        } else if rms > self.previous_rms * 1.12 {
            self.falling_energy_frames = self.falling_energy_frames.saturating_sub(1);
        }
        self.previous_rms = rms;
    }

    #[allow(clippy::cast_precision_loss)]
    fn finality_prediction(&self) -> EndpointingPrediction {
        let silence_score = (self.silence_duration_ms as f32 / 520.0).clamp(0.0, 1.0);
        let duration_score = (self.speech_duration_ms as f32 / 700.0).clamp(0.0, 1.0);
        let energy_fall_score = (f32::from(self.falling_energy_frames) / 6.0).clamp(0.0, 1.0);
        let turn_completion_confidence =
            (silence_score * 0.72 + duration_score * 0.28).clamp(0.0, 1.0);
        let prosodic_finality = (silence_score * 0.55 + energy_fall_score * 0.45).clamp(0.0, 1.0);
        let should_respond = turn_completion_confidence >= 0.74 && prosodic_finality >= 0.55;
        EndpointingPrediction {
            speech_duration_ms: self.speech_duration_ms,
            silence_duration_ms: self.silence_duration_ms,
            turn_completion_confidence,
            prosodic_finality,
            should_respond,
            reason: if should_respond {
                "speech ended with sufficient silence and falling energy".to_owned()
            } else {
                "waiting for more silence or clearer prosodic finality".to_owned()
            },
        }
    }
}

fn validate_frame(frame: &PcmAudioFrame) -> Result<(), String> {
    if frame.channels != 1 {
        return Err("only mono input is supported".to_owned());
    }
    if !(8_000..=48_000).contains(&frame.sample_rate) {
        return Err("input sample rate must be between 8 kHz and 48 kHz".to_owned());
    }
    if !(5..=100).contains(&frame.frame_duration_ms) {
        return Err("frame duration must be between 5 ms and 100 ms".to_owned());
    }
    Ok(())
}

fn expected_pcm_bytes(frame: &PcmAudioFrame) -> usize {
    usize::try_from(
        u64::from(frame.sample_rate)
            * u64::from(frame.frame_duration_ms)
            * u64::from(frame.channels)
            * 2
            / 1_000,
    )
    .unwrap_or_default()
}

#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
fn pcm_rms(bytes: &[u8]) -> f32 {
    let mut sum_squares = 0.0_f64;
    let mut sample_count = 0_u64;
    for pair in bytes.chunks_exact(2) {
        let sample = f64::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0;
        sum_squares += sample * sample;
        sample_count += 1;
    }
    (sum_squares / sample_count.max(1) as f64).sqrt() as f32
}

fn estimate_echo_probability(
    assistant_playout_active: bool,
    output_level: f32,
    input_rms: f32,
    server_probability: f32,
    client_probability: f32,
) -> f32 {
    if !assistant_playout_active {
        return 0.0;
    }
    if output_level > 0.0 {
        let output_dominance = (output_level / input_rms.max(0.001)).clamp(0.0, 1.0);
        return output_dominance
            .mul_add(0.75, (server_probability - client_probability) * 0.25)
            .clamp(0.0, 0.95);
    }
    (server_probability - client_probability).clamp(0.0, 0.35)
}

fn empty_prediction() -> EndpointingPrediction {
    EndpointingPrediction {
        speech_duration_ms: 0,
        silence_duration_ms: 0,
        turn_completion_confidence: 0.0,
        prosodic_finality: 0.0,
        should_respond: false,
        reason: "waiting for speech".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm_frame(sample: i16, client_probability: f32, output_level: f32) -> PcmAudioFrame {
        let bytes: Vec<u8> = (0..320).flat_map(|_| sample.to_le_bytes()).collect();
        PcmAudioFrame {
            pcm: bytes,
            sample_rate: 16_000,
            channels: 1,
            frame_duration_ms: 20,
            client_speech_probability: Some(client_probability),
            client_output_level: Some(output_level),
            client_echo_probability: None,
        }
    }

    #[test]
    fn rejects_wrong_frame_length() {
        let mut frame = pcm_frame(0, 0.0, 0.0);
        frame.pcm = vec![0_u8; 4];
        let error = AcousticFrontend::default()
            .analyze(&frame, false)
            .expect_err("length");
        assert!(error.contains("PCM length mismatch"));
    }

    #[test]
    fn detects_loud_target_speech() {
        let frame = pcm_frame(10_000, 1.0, 0.0);
        let analysis = AcousticFrontend::default()
            .analyze(&frame, false)
            .expect("analysis");
        assert!(analysis.speech_probability > 0.9);
        assert!(analysis.target_speaker_probability > 0.9);
    }

    #[test]
    fn output_reference_suppresses_echo_like_input() {
        let frame = pcm_frame(4_000, 0.05, 0.12);
        let analysis = AcousticFrontend::default()
            .analyze(&frame, true)
            .expect("analysis");
        assert!(analysis.echo_probability > 0.6);
        assert!(analysis.speech_probability < 0.35);
    }

    #[test]
    fn aligned_client_echo_reference_suppresses_false_barge_in() {
        let mut frame = pcm_frame(9_000, 0.95, 0.7);
        frame.client_echo_probability = Some(0.98);
        let analysis = AcousticFrontend::default()
            .analyze(&frame, true)
            .expect("analysis");
        assert!(analysis.echo_probability > 0.8);
        assert!(analysis.target_speaker_probability < 0.2);
    }

    #[test]
    fn endpointing_waits_through_short_pause() {
        let mut tracker = EndpointingTracker::default();
        let speech = AudioAnalysis {
            speech_probability: 0.9,
            echo_probability: 0.0,
            target_speaker_probability: 0.9,
            rms: 0.05,
        };
        let silence = AudioAnalysis {
            speech_probability: 0.1,
            echo_probability: 0.0,
            target_speaker_probability: 0.1,
            rms: 0.005,
        };
        for index in 0..25 {
            tracker.observe(index * 20_000, 20, &speech);
        }
        assert!(!tracker.observe(560_000, 20, &silence).should_respond);
        assert!(tracker.observe(1_080_000, 20, &silence).should_respond);
        tracker.reset();
        assert!(!tracker.observe(1_100_000, 20, &silence).should_respond);
    }
}
