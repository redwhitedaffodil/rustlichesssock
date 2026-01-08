use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tungstenite::{connect, Message, WebSocket};
use tungstenite::stream::MaybeTlsStream;
use std::net::TcpStream;
use url::Url;

/// WebSocket message types for Lichess protocol
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum LichessMessage {
    #[serde(rename = "move")]
    Move {
        d: MoveData,
    },
    #[serde(rename = "ack")]
    Ack {
        #[serde(default)]
        d: Option<serde_json::Value>,
    },
    #[serde(rename = "endData")]
    EndData {
        #[serde(default)]
        d: Option<EndData>,
    },
    #[serde(rename = "reload")]
    Reload,
    #[serde(rename = "resync")]
    Resync,
    #[serde(rename = "crowd")]
    Crowd {
        #[serde(default)]
        d: Option<serde_json::Value>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MoveData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub u: Option<String>,  // UCI move
    #[serde(skip_serializing_if = "Option::is_none")]
    pub a: Option<u32>,     // ack number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b: Option<u32>,     // berserked
    #[serde(skip_serializing_if = "Option::is_none")]
    pub l: Option<u32>,     // lag in ms
    #[serde(skip_serializing_if = "Option::is_none")]
    pub san: Option<String>, // SAN notation
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fen: Option<String>, // FEN position
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ply: Option<u32>,    // ply number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uci: Option<String>, // alternative UCI field
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EndData {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub winner: Option<String>,
}

/// WebSocket client for Lichess real-time game communication
pub struct LichessWebSocket {
    ws: Arc<Mutex<WebSocket<MaybeTlsStream<TcpStream>>>>,
    current_ack: Arc<AtomicU32>,
    game_ended: Arc<AtomicBool>,
    pending_move: Arc<Mutex<Option<String>>>,
    last_move_acked: Arc<AtomicBool>,
    game_id: String,
}

impl LichessWebSocket {
    /// Create a new WebSocket connection to Lichess
    pub fn new(game_id: &str, sri: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let ws_url = format!("wss://socket5.lichess.org/play/{}/v6?sri={}", game_id, sri);
        info!("[LichessWS] Connecting to: {}", ws_url);
        
        let url = Url::parse(&ws_url)?;
        let (ws, _) = connect(url)?;
        
        info!("[LichessWS] ✅ Connected successfully");
        
        Ok(LichessWebSocket {
            ws: Arc::new(Mutex::new(ws)),
            current_ack: Arc::new(AtomicU32::new(0)),
            game_ended: Arc::new(AtomicBool::new(false)),
            pending_move: Arc::new(Mutex::new(None)),
            last_move_acked: Arc::new(AtomicBool::new(false)),
            game_id: game_id.to_string(),
        })
    }
    
    /// Generate a Socket Request ID (12-char alphanumeric)
    pub fn generate_sri() -> String {
        use rand::Rng;
        const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let mut rng = rand::thread_rng();
        
        (0..12)
            .map(|_| {
                let idx = rng.gen_range(0..CHARSET.len());
                CHARSET[idx] as char
            })
            .collect()
    }
    
    /// Send a move to Lichess
    pub fn send_move(&self, uci: &str, lag_ms: u32, berserked: bool) -> Result<(), String> {
        // Check guards
        if self.game_ended.load(Ordering::Relaxed) {
            error!("[LichessWS] ❌ Game ended, blocking move: {}", uci);
            return Err("Game has ended".to_string());
        }
        
        // Check if there's a pending move
        {
            let pending = self.pending_move.lock().unwrap();
            if pending.is_some() {
                warn!("[LichessWS] ❌ Move pending, blocking: {}", uci);
                return Err("Move already pending".to_string());
            }
        }
        
        // Set pending move
        {
            let mut pending = self.pending_move.lock().unwrap();
            *pending = Some(uci.to_string());
        }
        self.last_move_acked.store(false, Ordering::Relaxed);
        
        // Construct move message
        let ack = self.current_ack.load(Ordering::Relaxed);
        let move_msg = serde_json::json!({
            "t": "move",
            "d": {
                "u": uci,
                "a": ack,
                "b": if berserked { 1 } else { 0 },
                "l": lag_ms
            }
        });
        
        info!("[Exec] ✅ Sending: {} | Lag: {}ms", uci, lag_ms);
        
        // Send the message
        let mut ws = self.ws.lock().unwrap();
        ws.send(Message::Text(move_msg.to_string()))
            .map_err(|e| format!("Failed to send move: {}", e))?;
        
        Ok(())
    }
    
    /// Process incoming WebSocket messages
    pub fn process_messages(&self) -> Result<Vec<String>, String> {
        let mut messages = Vec::new();
        let mut ws = self.ws.lock().unwrap();
        
        // Read all available messages (non-blocking)
        loop {
            match ws.read() {
                Ok(msg) => {
                    match msg {
                        Message::Text(text) => {
                            debug!("[LichessWS] ⬇️ Received: {}", text);
                            
                            // Try to parse as JSON
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                                if let Some(msg_type) = json.get("t").and_then(|t| t.as_str()) {
                                    match msg_type {
                                        "ack" => {
                                            self.last_move_acked.store(true, Ordering::Relaxed);
                                            let mut pending = self.pending_move.lock().unwrap();
                                            if let Some(uci) = pending.take() {
                                                info!("[ACK] Move accepted: {}", uci);
                                            }
                                        }
                                        "endData" => {
                                            self.game_ended.store(true, Ordering::Relaxed);
                                            info!("[Game] Ended - blocking further moves");
                                            messages.push("GAME_END".to_string());
                                        }
                                        "move" => {
                                            if let Some(d) = json.get("d") {
                                                // Update ply for ack tracking
                                                if let Some(ply) = d.get("ply").and_then(|p| p.as_u64()) {
                                                    self.current_ack.store(ply as u32, Ordering::Relaxed);
                                                }
                                                
                                                // Extract UCI move for highlighting
                                                if let Some(uci) = d.get("uci").and_then(|u| u.as_str()) {
                                                    messages.push(format!("MOVE:{}", uci));
                                                } else if let Some(u) = d.get("u").and_then(|u| u.as_str()) {
                                                    messages.push(format!("MOVE:{}", u));
                                                }
                                                
                                                // Extract FEN for sync
                                                if let Some(fen) = d.get("fen").and_then(|f| f.as_str()) {
                                                    messages.push(format!("FEN:{}", fen));
                                                }
                                                
                                                // Check for game end in move response
                                                if d.get("status").is_some() || d.get("winner").is_some() {
                                                    self.game_ended.store(true, Ordering::Relaxed);
                                                    messages.push("GAME_END".to_string());
                                                }
                                            }
                                        }
                                        "reload" | "resync" => {
                                            info!("[WebSocket] 🔄 {} received, resetting state", msg_type);
                                            // Clear pending move on reload/resync
                                            let mut pending = self.pending_move.lock().unwrap();
                                            *pending = None;
                                        }
                                        "crowd" => {
                                            // Player presence - log but don't process
                                            debug!("[LichessWS] Crowd update");
                                        }
                                        _ => {
                                            debug!("[LichessWS] Unhandled message type: {}", msg_type);
                                        }
                                    }
                                }
                            }
                        }
                        Message::Ping(data) => {
                            ws.send(Message::Pong(data))
                                .map_err(|e| format!("Failed to send pong: {}", e))?;
                        }
                        Message::Close(_) => {
                            info!("[LichessWS] Connection closed");
                            break;
                        }
                        _ => {}
                    }
                }
                Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // No more messages available
                    break;
                }
                Err(e) => {
                    error!("[LichessWS] Error reading message: {}", e);
                    break;
                }
            }
        }
        
        Ok(messages)
    }
    
    /// Check if the game has ended
    pub fn is_game_ended(&self) -> bool {
        self.game_ended.load(Ordering::Relaxed)
    }
    
    /// Get the game ID
    pub fn game_id(&self) -> &str {
        &self.game_id
    }
}
