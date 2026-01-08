use log::{debug, info, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Controller for automatic move execution with engine integration
pub struct AutoMoveController {
    enabled: Arc<AtomicBool>,
    panic_mode: Arc<AtomicBool>,
    engine_calculating: Arc<AtomicBool>,
    last_move_sent: Option<String>,
    last_move_time: Option<Instant>,
}

impl AutoMoveController {
    /// Create a new auto-move controller
    pub fn new() -> Self {
        AutoMoveController {
            enabled: Arc::new(AtomicBool::new(false)),
            panic_mode: Arc::new(AtomicBool::new(false)),
            engine_calculating: Arc::new(AtomicBool::new(false)),
            last_move_sent: None,
            last_move_time: None,
        }
    }
    
    /// Toggle auto-move on/off
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        if enabled {
            info!("[AutoMove] Enabled");
        } else {
            info!("[AutoMove] Disabled");
        }
    }
    
    /// Check if auto-move is enabled
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
    
    /// Toggle panic mode on/off
    pub fn set_panic_mode(&mut self, panic: bool) {
        self.panic_mode.store(panic, Ordering::Relaxed);
        if panic {
            info!("[AutoMove] ⚡ PANIC MODE Enabled");
        } else {
            info!("[AutoMove] PANIC MODE Disabled");
        }
    }
    
    /// Check if panic mode is enabled
    pub fn is_panic_mode(&self) -> bool {
        self.panic_mode.load(Ordering::Relaxed)
    }
    
    /// Check if we should execute an auto-move
    pub fn should_auto_move(&self, is_our_turn: bool) -> bool {
        if !self.enabled.load(Ordering::Relaxed) {
            return false;
        }
        
        if !is_our_turn {
            return false;
        }
        
        if self.engine_calculating.load(Ordering::Relaxed) {
            debug!("[AutoMove] Engine still calculating");
            return false;
        }
        
        true
    }
    
    /// Execute an auto-move with duplicate prevention and lag compensation
    pub fn execute_auto_move(
        &mut self,
        uci: &str,
        ws: &crate::lichess_ws::LichessWebSocket,
    ) -> bool {
        // Duplicate check with 500ms window
        let now = Instant::now();
        if let (Some(last_uci), Some(last_time)) = (&self.last_move_sent, &self.last_move_time) {
            if last_uci == uci && now.duration_since(*last_time) < Duration::from_millis(500) {
                warn!("[AutoMove] ❌ Duplicate blocked: {}", uci);
                return false;
            }
        }
        
        // Update last move tracking
        self.last_move_sent = Some(uci.to_string());
        self.last_move_time = Some(now);
        
        // Calculate lag compensation
        let lag_ms = if self.panic_mode.load(Ordering::Relaxed) {
            50 // Panic mode: 50ms lag
        } else {
            20 // Normal mode: 20ms lag
        };
        
        let berserked = self.panic_mode.load(Ordering::Relaxed);
        
        // Send the move
        match ws.send_move(uci, lag_ms, berserked) {
            Ok(_) => {
                info!("[AutoMove] ✅ Executed: {} | Lag: {}ms{}", 
                    uci, lag_ms, if berserked { " [PANIC]" } else { "" });
                true
            }
            Err(e) => {
                warn!("[AutoMove] ❌ Failed to send move: {}", e);
                false
            }
        }
    }
    
    /// Mark engine as calculating
    pub fn set_engine_calculating(&mut self, calculating: bool) {
        self.engine_calculating.store(calculating, Ordering::Relaxed);
    }
    
    /// Check if engine is calculating
    pub fn is_engine_calculating(&self) -> bool {
        self.engine_calculating.load(Ordering::Relaxed)
    }
}

impl Default for AutoMoveController {
    fn default() -> Self {
        Self::new()
    }
}
