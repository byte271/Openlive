use std::{error::Error, fmt};

use uuid::Uuid;

const MAGIC: [u8; 4] = *b"OLIV";
const WIRE_VERSION: u8 = 1;
const HEADER_LEN: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MediaKind {
    InputAudio = 1,
    OutputAudio = 2,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PcmAudioFrame {
    pub pcm: Vec<u8>,
    pub sample_rate: u32,
    pub channels: u8,
    pub frame_duration_ms: u16,
    pub client_speech_probability: Option<f32>,
    pub client_output_level: Option<f32>,
    pub client_echo_probability: Option<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MediaPacket {
    pub kind: MediaKind,
    pub sequence: u64,
    pub media_time_us: u64,
    pub generation_id: Option<Uuid>,
    pub audio: PcmAudioFrame,
}

impl MediaPacket {
    #[must_use]
    pub fn encode(&self) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(HEADER_LEN + self.audio.pcm.len());
        encoded.extend_from_slice(&MAGIC);
        encoded.push(WIRE_VERSION);
        encoded.push(self.kind as u8);
        encoded.extend_from_slice(&0_u16.to_le_bytes());
        encoded.extend_from_slice(&self.sequence.to_le_bytes());
        encoded.extend_from_slice(&self.media_time_us.to_le_bytes());
        encoded.extend_from_slice(self.generation_id.unwrap_or(Uuid::nil()).as_bytes());
        encoded.extend_from_slice(&self.audio.sample_rate.to_le_bytes());
        encoded.extend_from_slice(&self.audio.frame_duration_ms.to_le_bytes());
        encoded.push(self.audio.channels);
        encoded.push(0);
        encoded.extend_from_slice(
            &self
                .audio
                .client_speech_probability
                .unwrap_or(f32::NAN)
                .to_le_bytes(),
        );
        encoded.extend_from_slice(
            &self
                .audio
                .client_output_level
                .unwrap_or(f32::NAN)
                .to_le_bytes(),
        );
        encoded.extend_from_slice(
            &self
                .audio
                .client_echo_probability
                .unwrap_or(f32::NAN)
                .to_le_bytes(),
        );
        encoded.extend_from_slice(&self.audio.pcm);
        encoded
    }

    /// Decodes one Openlive media packet.
    ///
    /// # Errors
    ///
    /// Returns an error for a truncated header, invalid magic/version/kind,
    /// missing PCM payload, or unsupported audio metadata.
    pub fn decode(encoded: &[u8]) -> Result<Self, MediaPacketError> {
        if encoded.len() < HEADER_LEN {
            return Err(MediaPacketError::Truncated);
        }
        if encoded[..4] != MAGIC {
            return Err(MediaPacketError::InvalidMagic);
        }
        if encoded[4] != WIRE_VERSION {
            return Err(MediaPacketError::UnsupportedVersion(encoded[4]));
        }
        let kind = match encoded[5] {
            1 => MediaKind::InputAudio,
            2 => MediaKind::OutputAudio,
            value => return Err(MediaPacketError::InvalidKind(value)),
        };
        let sequence = read_u64(encoded, 8);
        let media_time_us = read_u64(encoded, 16);
        let generation =
            Uuid::from_slice(&encoded[24..40]).map_err(|_| MediaPacketError::InvalidGeneration)?;
        let generation_id = (!generation.is_nil()).then_some(generation);
        let sample_rate = read_u32(encoded, 40);
        let frame_duration_ms = read_u16(encoded, 44);
        let channels = encoded[46];
        let pcm = encoded[HEADER_LEN..].to_vec();
        if pcm.is_empty() {
            return Err(MediaPacketError::MissingPayload);
        }
        if channels != 1
            || !(8_000..=48_000).contains(&sample_rate)
            || !(5..=100).contains(&frame_duration_ms)
        {
            return Err(MediaPacketError::InvalidAudioMetadata);
        }
        Ok(Self {
            kind,
            sequence,
            media_time_us,
            generation_id,
            audio: PcmAudioFrame {
                pcm,
                sample_rate,
                channels,
                frame_duration_ms,
                client_speech_probability: read_optional_f32(encoded, 48),
                client_output_level: read_optional_f32(encoded, 52),
                client_echo_probability: read_optional_f32(encoded, 56),
            },
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaPacketError {
    Truncated,
    InvalidMagic,
    UnsupportedVersion(u8),
    InvalidKind(u8),
    InvalidGeneration,
    MissingPayload,
    InvalidAudioMetadata,
}

impl fmt::Display for MediaPacketError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => formatter.write_str("media packet header is truncated"),
            Self::InvalidMagic => formatter.write_str("media packet magic is invalid"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported media packet version {version}")
            }
            Self::InvalidKind(kind) => write!(formatter, "invalid media packet kind {kind}"),
            Self::InvalidGeneration => formatter.write_str("invalid media generation ID"),
            Self::MissingPayload => formatter.write_str("media packet has no PCM payload"),
            Self::InvalidAudioMetadata => formatter.write_str("media audio metadata is invalid"),
        }
    }
}

impl Error for MediaPacketError {}

fn read_u16(encoded: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([encoded[offset], encoded[offset + 1]])
}

fn read_u32(encoded: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        encoded[offset],
        encoded[offset + 1],
        encoded[offset + 2],
        encoded[offset + 3],
    ])
}

fn read_u64(encoded: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes([
        encoded[offset],
        encoded[offset + 1],
        encoded[offset + 2],
        encoded[offset + 3],
        encoded[offset + 4],
        encoded[offset + 5],
        encoded[offset + 6],
        encoded[offset + 7],
    ])
}

fn read_optional_f32(encoded: &[u8], offset: usize) -> Option<f32> {
    let value = f32::from_le_bytes([
        encoded[offset],
        encoded[offset + 1],
        encoded[offset + 2],
        encoded[offset + 3],
    ]);
    value.is_finite().then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_round_trips_without_base64() {
        let packet = MediaPacket {
            kind: MediaKind::InputAudio,
            sequence: 42,
            media_time_us: 840_000,
            generation_id: None,
            audio: PcmAudioFrame {
                pcm: vec![1, 2, 3, 4],
                sample_rate: 16_000,
                channels: 1,
                frame_duration_ms: 20,
                client_speech_probability: Some(0.8),
                client_output_level: Some(0.2),
                client_echo_probability: None,
            },
        };
        let decoded = MediaPacket::decode(&packet.encode()).expect("decode");
        assert_eq!(decoded, packet);
    }

    #[test]
    fn rejects_corrupt_or_truncated_packets() {
        assert_eq!(
            MediaPacket::decode(&[0; 8]),
            Err(MediaPacketError::Truncated)
        );
        let mut packet = MediaPacket {
            kind: MediaKind::InputAudio,
            sequence: 1,
            media_time_us: 0,
            generation_id: None,
            audio: PcmAudioFrame {
                pcm: vec![0; 640],
                sample_rate: 16_000,
                channels: 1,
                frame_duration_ms: 20,
                client_speech_probability: None,
                client_output_level: None,
                client_echo_probability: None,
            },
        }
        .encode();
        packet[0] = b'X';
        assert_eq!(
            MediaPacket::decode(&packet),
            Err(MediaPacketError::InvalidMagic)
        );

        let mut unsupported = MediaPacket {
            kind: MediaKind::InputAudio,
            sequence: 1,
            media_time_us: 0,
            generation_id: None,
            audio: PcmAudioFrame {
                pcm: vec![0; 640],
                sample_rate: 16_000,
                channels: 1,
                frame_duration_ms: 20,
                client_speech_probability: None,
                client_output_level: None,
                client_echo_probability: None,
            },
        }
        .encode();
        unsupported[4] = 2;
        assert_eq!(
            MediaPacket::decode(&unsupported),
            Err(MediaPacketError::UnsupportedVersion(2))
        );
        unsupported[4] = 1;
        unsupported[5] = 9;
        assert_eq!(
            MediaPacket::decode(&unsupported),
            Err(MediaPacketError::InvalidKind(9))
        );
    }
}
