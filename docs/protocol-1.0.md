# Openlive protocol 1.0

One WebSocket carries two ordered message classes:

- UTF-8 JSON control envelopes.
- Binary PCM media packets.

Both share a single monotonically increasing sequence space per direction. Client media time must never move backward within one stream. The connection binds binary input to the allocated session, so the media header does not repeat the session UUID.

## Binary media header

All integers use little-endian encoding.

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII magic `OLIV` |
| 4 | 1 | media wire version (`1`) |
| 5 | 1 | kind: input audio (`1`) or output audio (`2`) |
| 6 | 2 | reserved flags |
| 8 | 8 | sequence |
| 16 | 8 | media time in microseconds |
| 24 | 16 | generation UUID; nil for input |
| 40 | 4 | sample rate |
| 44 | 2 | frame duration in milliseconds |
| 46 | 1 | channels |
| 47 | 1 | reserved |
| 48 | 4 | client speech probability or NaN |
| 52 | 4 | client output RMS or NaN |
| 56 | 4 | client echo probability or NaN |
| 60 | remaining | signed 16-bit little-endian PCM |

The gateway currently accepts mono PCM at 8–48 kHz with 5–100 ms declared frames. The audio frontend additionally verifies that payload length exactly matches the declared rate and duration.

## Control envelopes

Control messages retain the versioned JSON envelope:

```json
{
  "protocol_version": "1.0",
  "event_id": "uuid",
  "session_id": "uuid",
  "stream_id": "session",
  "sequence": 1,
  "media_time_us": 0,
  "generation_id": null,
  "parent_event_id": null,
  "type": "session_configured",
  "payload": {}
}
```

Audio is not valid inside JSON control events in protocol 1.0. Providers also exchange raw PCM internally; base64 remains only at external APIs that require it.

## Ordering and cancellation

- Sequence numbers strictly increase across control and media messages.
- Media timestamps may be equal but cannot decrease within a client stream.
- Output media names its exact generation.
- A revoked answer lease suppresses every later output from that generation.
- `output_audio_cancel` identifies the generation and requested cutoff.
- `output_audio_played` advances the authoritative audible position.

Malformed packets, replayed sequences, backward media time, and client-sent output packets produce recoverable protocol errors.
