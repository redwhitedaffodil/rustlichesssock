use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LichessSession {
    pub session_id: String,
    pub csrf_token: Option<String>,
    pub username: Option<String>,
}

impl LichessSession {
    /// Get the path for session storage
    pub fn session_path() -> Result<PathBuf, Box<dyn Error>> {
        let config_dir = crate::constants::config_dir()?;
        let session_path = config_dir.join("chess-tui/lichess_session.json");
        Ok(session_path)
    }
    
    /// Load existing session or return error prompting login
    pub fn load_or_create() -> Result<Self, Box<dyn Error>> {
        let session_path = Self::session_path()?;
        
        if session_path.exists() {
            let content = fs::read_to_string(&session_path)?;
            let session: LichessSession = serde_json::from_str(&content)?;
            info!("[LichessAuth] Loaded session for user: {:?}", session.username);
            Ok(session)
        } else {
            error!("[LichessAuth] No session found. Please run with --lichess-login to authenticate.");
            Err("No Lichess session found. Please authenticate first.".into())
        }
    }
    
    /// Save the session to disk
    pub fn save(&self) -> Result<(), Box<dyn Error>> {
        let session_path = Self::session_path()?;
        
        // Ensure directory exists
        if let Some(parent) = session_path.parent() {
            fs::create_dir_all(parent)?;
        }
        
        let content = serde_json::to_string_pretty(self)?;
        fs::write(&session_path, content)?;
        
        info!("[LichessAuth] Session saved for user: {:?}", self.username);
        Ok(())
    }
    
    /// Validate the session by checking against Lichess API
    pub fn validate(&self) -> Result<bool, Box<dyn Error>> {
        // For now, we'll assume session is valid if it exists
        // In a full implementation, we'd make an API call to /api/account
        // using the session cookie to verify it's still valid
        warn!("[LichessAuth] Session validation not fully implemented - assuming valid");
        Ok(true)
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
    
    /// Create a new session (called after browser login)
    pub fn new(session_id: String, csrf_token: Option<String>, username: Option<String>) -> Self {
        LichessSession {
            session_id,
            csrf_token,
            username,
        }
    }
}
