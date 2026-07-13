use std::time::Duration;

use openlive_protocol::{ProviderLifecycleState, RealtimeEvent};
use openlive_provider::{
    MockDuplexProvider, ProviderInput, ProviderSessionRequest, RealtimeProvider,
};
use tokio::time::timeout;
use uuid::Uuid;

#[tokio::test]
async fn mock_provider_obeys_generation_and_lifecycle_contract() {
    let provider = MockDuplexProvider::default();
    let manifest = provider.manifest();
    assert!(manifest.duplex.continuous_input_while_output);
    assert!(manifest.control.cancel_generation);
    assert!(manifest.duplex.state_tokens);

    let session = provider
        .open_session(ProviderSessionRequest {
            session_id: Uuid::new_v4(),
        })
        .await
        .expect("session");
    let (input, mut output) = session.into_parts();
    let first_generation = Uuid::new_v4();
    input
        .send(commit(first_generation, 1))
        .await
        .expect("first commit");
    let first_emission = timeout(Duration::from_secs(1), output.recv())
        .await
        .expect("first emission timeout")
        .expect("first emission");
    assert_eq!(first_emission.generation_id, Some(first_generation));

    input
        .send(ProviderInput::CancelGeneration {
            generation_id: first_generation,
        })
        .await
        .expect("cancel");
    let second_generation = Uuid::new_v4();
    input
        .send(commit(second_generation, 2))
        .await
        .expect("second commit");

    let mut second_started = false;
    let mut previous_offset = 0;
    loop {
        let emission = timeout(Duration::from_secs(2), output.recv())
            .await
            .expect("provider stalled")
            .expect("provider closed");
        if emission.generation_id == Some(second_generation) {
            second_started = true;
            if matches!(&emission.event, RealtimeEvent::OutputAudioFrame(_)) {
                assert!(emission.media_offset_us >= previous_offset);
                previous_offset = emission.media_offset_us;
            }
        } else if second_started {
            assert_ne!(emission.generation_id, Some(first_generation));
        }
        let complete = emission.generation_id == Some(second_generation)
            && matches!(
                emission.event,
                RealtimeEvent::ProviderState(ref state)
                    if state.state == ProviderLifecycleState::Complete
            );
        if complete {
            break;
        }
    }

    input.send(ProviderInput::Close).await.expect("close");
    loop {
        if timeout(Duration::from_secs(1), output.recv())
            .await
            .expect("close timeout")
            .is_none()
        {
            break;
        }
    }
}

fn commit(generation_id: Uuid, conversation_version: u64) -> ProviderInput {
    ProviderInput::CommitResponse {
        generation_id,
        conversation_version,
        media_time_us: 0,
        prompt_hint: "conformance test".to_owned(),
    }
}
