# Openlive 1.1

Openlive 1.1 replaces the engineering dashboard with an original immersive voice client. The release changes presentation and browser session behavior while retaining protocol 1.0 compatibility.

## Voice experience

- One primary action opens the realtime session and microphone.
- A canvas-rendered voice presence reacts to local speech and rendered output.
- Listening, thinking, speaking, interrupted, muted, reconnecting, and error states have distinct motion, color, and concise copy.
- Assistant text is temporary and yields visual priority to the live conversation.
- Settings remain close to the primary controls.
- Runtime metrics and the event timeline move into an optional diagnostics drawer.
- Missing or denied microphone access appears in the main voice surface rather than only in logs.

The visual system is original. It uses layered procedural geometry and does not reproduce a proprietary interface or its assets.

## Realtime behavior

- Local speech activity updates the interface before a server round trip.
- Rendered output level drives the speaking state from the audio thread.
- Local reversible ducking immediately enters the interrupted state.
- Balanced pause tolerance is reduced to 520 ms for quicker turn commitment.
- Unexpected transport closure cancels stale playback and retries with bounded exponential backoff.
- Microphone capture can remain active across a reconnect, while an intentional end closes both planes.
- Ending a conversation cancels queued generations and resets visual/audio state.
- Microphone pause and resume reuse the audio context without re-registering AudioWorklet processors.

## Validation boundaries

- The mock provider validates lifecycle, playback, interruption, and state transitions; its generated tone is not a speech-quality demonstration.
- Real voice naturalness depends on the configured native duplex or cascade provider.
- A visual redesign cannot remove model-side latency or reproduce a proprietary model's learned timing and prosody.
- Openlive still does not claim GPT-Live parity.
