//! Gateway-native WebRTC peer sessions (webrtc-rs).
//!
//! ICE/DTLS via WebRTC-rs; OpenLive media rides on data channels:
//! - `openlive-events` — JSON control (same envelopes as WebSocket)
//! - `openlive-media` — unordered binary PCM16 LE (app-layer framing)
//!
//! Credit: [webrtc-rs](https://github.com/webrtc-rs/webrtc) (MIT/Apache-2.0).

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use bytes::Bytes;
use tokio::sync::mpsc;
use tracing::info;
use uuid::Uuid;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine, APIBuilder,
        API,
    },
    data_channel::{
        data_channel_init::RTCDataChannelInit, data_channel_message::DataChannelMessage,
        RTCDataChannel,
    },
    ice_transport::ice_server::RTCIceServer,
    interceptor::registry::Registry,
    peer_connection::{
        configuration::RTCConfiguration, peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
};

#[derive(Debug)]
pub enum WebRtcError {
    Internal(String),
    InvalidSdp(String),
}

impl std::fmt::Display for WebRtcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Internal(s) | Self::InvalidSdp(s) => write!(f, "{s}"),
        }
    }
}

impl std::error::Error for WebRtcError {}

#[derive(Debug, Clone)]
pub enum PeerInbound {
    ControlText(String),
    MediaBinary(Vec<u8>),
    Closed,
}

#[derive(Debug, Clone)]
pub enum PeerOutbound {
    ControlText(String),
    MediaBinary(Vec<u8>),
}

pub struct WebRtcHub {
    api: API,
    peers: Mutex<HashMap<Uuid, Arc<RTCPeerConnection>>>,
}

pub struct WebRtcPeerSession {
    pub id: Uuid,
    pc: Arc<RTCPeerConnection>,
    inbound: mpsc::Receiver<PeerInbound>,
    outbound: mpsc::Sender<PeerOutbound>,
}

impl WebRtcHub {
    /// # Errors
    /// Returns when codecs / interceptors cannot be registered.
    pub fn new() -> Result<Self, WebRtcError> {
        let mut media = MediaEngine::default();
        media
            .register_default_codecs()
            .map_err(|e| WebRtcError::Internal(e.to_string()))?;
        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut media)
            .map_err(|e| WebRtcError::Internal(e.to_string()))?;
        let api = APIBuilder::new()
            .with_media_engine(media)
            .with_interceptor_registry(registry)
            .build();
        Ok(Self {
            api,
            peers: Mutex::new(HashMap::new()),
        })
    }

    #[must_use]
    pub fn peer_count(&self) -> usize {
        self.peers.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// Answer a browser SDP offer. Returns (answer_sdp, session).
    ///
    /// # Errors
    /// Returns on SDP or peer-connection failures.
    pub async fn accept_offer(
        &self,
        offer_sdp: &str,
    ) -> Result<(String, WebRtcPeerSession), WebRtcError> {
        let config = RTCConfiguration {
            ice_servers: vec![
                RTCIceServer {
                    urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                    ..Default::default()
                },
                RTCIceServer {
                    urls: vec!["stun:stun1.l.google.com:19302".to_owned()],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let pc = Arc::new(
            self.api
                .new_peer_connection(config)
                .await
                .map_err(|e| WebRtcError::Internal(e.to_string()))?,
        );
        let session_id = Uuid::new_v4();

        let (inbound_tx, inbound_rx) = mpsc::channel::<PeerInbound>(64);
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<PeerOutbound>(64);
        let events_open = Arc::new(AtomicBool::new(false));
        let media_open = Arc::new(AtomicBool::new(false));
        let events_holder: Arc<Mutex<Option<Arc<RTCDataChannel>>>> =
            Arc::new(Mutex::new(None));
        let media_holder: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));

        let events_dc = pc
            .create_data_channel(
                "openlive-events",
                Some(RTCDataChannelInit {
                    ordered: Some(true),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| WebRtcError::Internal(e.to_string()))?;
        let media_dc = pc
            .create_data_channel(
                "openlive-media",
                Some(RTCDataChannelInit {
                    ordered: Some(false),
                    max_retransmits: Some(0),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| WebRtcError::Internal(e.to_string()))?;

        {
            let mut g = events_holder.lock().map_err(|e| {
                WebRtcError::Internal(format!("events lock: {e}"))
            })?;
            *g = Some(events_dc.clone());
        }
        {
            let mut g = media_holder.lock().map_err(|e| {
                WebRtcError::Internal(format!("media lock: {e}"))
            })?;
            *g = Some(media_dc.clone());
        }

        wire_channel(
            events_dc,
            inbound_tx.clone(),
            events_open.clone(),
            ChannelKind::Events,
        );
        wire_channel(
            media_dc,
            inbound_tx.clone(),
            media_open.clone(),
            ChannelKind::Media,
        );

        // Accept browser-created channels (some clients create first).
        let inbound_pc = inbound_tx.clone();
        let events_open_pc = events_open.clone();
        let media_open_pc = media_open.clone();
        let events_holder_pc = events_holder.clone();
        let media_holder_pc = media_holder.clone();
        pc.on_data_channel(Box::new(move |d| {
            let label = d.label().to_owned();
            let inbound_pc = inbound_pc.clone();
            let events_open_pc = events_open_pc.clone();
            let media_open_pc = media_open_pc.clone();
            let events_holder_pc = events_holder_pc.clone();
            let media_holder_pc = media_holder_pc.clone();
            Box::pin(async move {
                let kind = if label == "openlive-events" || label == "oai-events" {
                    if let Ok(mut g) = events_holder_pc.lock() {
                        *g = Some(d.clone());
                    }
                    ChannelKind::Events
                } else {
                    if let Ok(mut g) = media_holder_pc.lock() {
                        *g = Some(d.clone());
                    }
                    ChannelKind::Media
                };
                let flag = match kind {
                    ChannelKind::Events => events_open_pc,
                    ChannelKind::Media => media_open_pc,
                };
                wire_channel(d, inbound_pc, flag, kind);
            })
        }));

        let close_tx = inbound_tx.clone();
        pc.on_peer_connection_state_change(Box::new(move |state| {
            let close_tx = close_tx.clone();
            Box::pin(async move {
                if matches!(
                    state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    let _ = close_tx.try_send(PeerInbound::Closed);
                }
            })
        }));

        // Outbound pump
        let events_holder_w = events_holder.clone();
        let media_holder_w = media_holder.clone();
        let events_open_w = events_open.clone();
        let media_open_w = media_open.clone();
        tokio::spawn(async move {
            while let Some(msg) = outbound_rx.recv().await {
                match msg {
                    PeerOutbound::ControlText(text) if events_open_w.load(Ordering::Relaxed) => {
                        let ch = events_holder_w
                            .lock()
                            .ok()
                            .and_then(|g| g.as_ref().cloned());
                        if let Some(ch) = ch {
                            let _ = ch.send_text(text).await;
                        }
                    }
                    PeerOutbound::MediaBinary(bin) if media_open_w.load(Ordering::Relaxed) => {
                        let ch = media_holder_w
                            .lock()
                            .ok()
                            .and_then(|g| g.as_ref().cloned());
                        if let Some(ch) = ch {
                            let _ = ch.send(&Bytes::from(bin)).await;
                        }
                    }
                    _ => {}
                }
            }
        });

        let offer = RTCSessionDescription::offer(offer_sdp.to_owned())
            .map_err(|e| WebRtcError::InvalidSdp(e.to_string()))?;
        pc.set_remote_description(offer)
            .await
            .map_err(|e| WebRtcError::InvalidSdp(e.to_string()))?;
        let answer = pc
            .create_answer(None)
            .await
            .map_err(|e| WebRtcError::Internal(e.to_string()))?;
        let mut gather_complete = pc.gathering_complete_promise().await;
        pc.set_local_description(answer)
            .await
            .map_err(|e| WebRtcError::Internal(e.to_string()))?;
        let _ = gather_complete.recv().await;
        let local = pc
            .local_description()
            .await
            .ok_or_else(|| WebRtcError::Internal("missing local description".into()))?;

        if let Ok(mut peers) = self.peers.lock() {
            peers.insert(session_id, pc.clone());
        }

        info!(%session_id, "gateway-native WebRTC answer ready");
        Ok((
            local.sdp,
            WebRtcPeerSession {
                id: session_id,
                pc,
                inbound: inbound_rx,
                outbound: outbound_tx,
            },
        ))
    }

    /// Drop a peer from the hub map and close its PeerConnection.
    #[allow(dead_code)]
    pub async fn close_peer(&self, id: Uuid) {
        let pc = self.peers.lock().ok().and_then(|mut g| g.remove(&id));
        if let Some(pc) = pc {
            let _ = pc.close().await;
        }
    }
}

impl WebRtcPeerSession {
    pub async fn send_control(&self, text: String) {
        let _ = self.outbound.send(PeerOutbound::ControlText(text)).await;
    }

    pub async fn send_media(&self, bytes: Vec<u8>) {
        let _ = self.outbound.send(PeerOutbound::MediaBinary(bytes)).await;
    }

    pub async fn recv(&mut self) -> Option<PeerInbound> {
        self.inbound.recv().await
    }

    pub async fn close(self) {
        let _ = self.pc.close().await;
    }
}

#[derive(Clone, Copy)]
enum ChannelKind {
    Events,
    Media,
}

fn wire_channel(
    d: Arc<RTCDataChannel>,
    inbound: mpsc::Sender<PeerInbound>,
    open_flag: Arc<AtomicBool>,
    kind: ChannelKind,
) {
    let open_o = open_flag.clone();
    d.on_open(Box::new(move || {
        open_o.store(true, Ordering::Relaxed);
        Box::pin(async {})
    }));
    let open_c = open_flag.clone();
    d.on_close(Box::new(move || {
        open_c.store(false, Ordering::Relaxed);
        Box::pin(async {})
    }));
    d.on_message(Box::new(move |msg: DataChannelMessage| {
        let inbound = inbound.clone();
        Box::pin(async move {
            match kind {
                ChannelKind::Events => {
                    if let Ok(text) = String::from_utf8(msg.data.to_vec()) {
                        let _ = inbound.send(PeerInbound::ControlText(text)).await;
                    }
                }
                ChannelKind::Media => {
                    let _ = inbound
                        .send(PeerInbound::MediaBinary(msg.data.to_vec()))
                        .await;
                }
            }
        })
    }));
}

