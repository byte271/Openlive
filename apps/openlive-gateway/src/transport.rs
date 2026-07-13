use axum::extract::ws::{Message, WebSocket};
use futures_util::{stream::SplitStream, SinkExt, StreamExt};
use openlive_protocol::EventEnvelope;
use tokio::{sync::mpsc, task::JoinHandle};

pub(crate) struct WebSocketTransport {
    pub incoming: SplitStream<WebSocket>,
    pub outgoing: mpsc::Sender<EventEnvelope>,
    writer: JoinHandle<()>,
}

impl WebSocketTransport {
    pub(crate) fn start(socket: WebSocket) -> Self {
        let (mut socket_sender, incoming) = socket.split();
        let (outgoing, mut outgoing_receiver) = mpsc::channel::<EventEnvelope>(128);
        let writer = tokio::spawn(async move {
            while let Some(event) = outgoing_receiver.recv().await {
                let Ok(json) = serde_json::to_string(&event) else {
                    continue;
                };
                if socket_sender.send(Message::Text(json)).await.is_err() {
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
