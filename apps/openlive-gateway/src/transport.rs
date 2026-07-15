use axum::extract::ws::{Message, WebSocket};
use futures_util::{stream::SplitStream, SinkExt, StreamExt};
use openlive_protocol::{EventEnvelope, MediaPacket};
use tokio::{sync::mpsc, task::JoinHandle};

pub(crate) enum ServerMessage {
    Control(EventEnvelope),
    Media(MediaPacket),
    /// Pre-serialized JSON text. Used by the resume replay path so the
    /// original `event_id` and sequence number are preserved byte-for-byte
    /// (which is what makes client-side dedup reliable).
    RawText(String),
}

pub(crate) struct WebSocketTransport {
    pub incoming: SplitStream<WebSocket>,
    pub outgoing: mpsc::Sender<ServerMessage>,
    writer: JoinHandle<()>,
}

impl WebSocketTransport {
    pub(crate) fn start(socket: WebSocket) -> Self {
        let (mut socket_sender, incoming) = socket.split();
        let (outgoing, mut outgoing_receiver) = mpsc::channel::<ServerMessage>(64);
        let writer = tokio::spawn(async move {
            while let Some(message) = outgoing_receiver.recv().await {
                let message = match message {
                    ServerMessage::Control(event) => {
                        let Ok(json) = serde_json::to_string(&event) else {
                            continue;
                        };
                        Message::Text(json)
                    }
                    ServerMessage::Media(packet) => Message::Binary(packet.encode()),
                    ServerMessage::RawText(json) => Message::Text(json),
                };
                if socket_sender.send(message).await.is_err() {
                    break;
                }
            }
        });
        Self {
            incoming,
            outgoing,
            writer,
        }
    }

    pub(crate) async fn finish(self) {
        drop(self.outgoing);
        let _ = self.writer.await;
    }
}
