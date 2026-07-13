use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnswerLease {
    pub lease_id: Uuid,
    pub conversation_version: u64,
    pub generation_id: Uuid,
}

#[derive(Debug)]
pub struct AnswerLeaseManager {
    session_id: Uuid,
    conversation_version: u64,
    lease_sequence: u64,
    user_turn_open: bool,
    active: Option<AnswerLease>,
}

impl AnswerLeaseManager {
    #[must_use]
    pub const fn new(session_id: Uuid) -> Self {
        Self {
            session_id,
            conversation_version: 0,
            lease_sequence: 0,
            user_turn_open: false,
            active: None,
        }
    }

    pub fn begin_user_turn(&mut self) {
        if self.user_turn_open {
            return;
        }
        self.conversation_version = self.conversation_version.saturating_add(1);
        self.user_turn_open = true;
        self.active = None;
    }

    pub fn issue(&mut self, generation_id: Uuid) -> AnswerLease {
        self.lease_sequence = self.lease_sequence.saturating_add(1);
        self.user_turn_open = false;
        let name = format!(
            "answer:{}:{}",
            self.conversation_version, self.lease_sequence
        );
        let lease = AnswerLease {
            lease_id: Uuid::new_v5(&self.session_id, name.as_bytes()),
            conversation_version: self.conversation_version,
            generation_id,
        };
        self.active = Some(lease);
        lease
    }

    pub fn revoke(&mut self, generation_id: Uuid) {
        if self
            .active
            .is_some_and(|lease| lease.generation_id == generation_id)
        {
            self.active = None;
        }
    }

    #[must_use]
    pub fn accepts(&self, generation_id: Uuid) -> bool {
        self.active
            .is_some_and(|lease| lease.generation_id == generation_id)
    }

    #[must_use]
    pub const fn active(&self) -> Option<AnswerLease> {
        self.active
    }
}
