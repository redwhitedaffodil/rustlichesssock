# Integration Guide: WebSocket Lichess

This guide shows exactly how to integrate the WebSocket infrastructure into the existing application.

## Overview

The WebSocket infrastructure is complete and ready. Integration requires modifying:
- `src/app.rs` - Add WebSocket fields and processing
- `src/main.rs` - Add CLI argument and WebSocket message handling
- `src/lichess.rs` - Update game creation to use WebSocket

## Step 1: Update App Struct

In `src/app.rs`, modify the `App` struct:

```rust
pub struct App {
    // ... existing fields ...
    
    // REMOVE (breaking change):
    // pub lichess_token: Option<String>,
    
    // ADD:
    pub lichess_session: Option<crate::lichess_auth::LichessSession>,
    pub lichess_ws: Option<std::sync::Arc<std::sync::Mutex<crate::lichess_ws::LichessWebSocket>>>,
    pub auto_move_controller: Option<crate::auto_move::AutoMoveController>,
}
```

In `App::default()`:

```rust
impl Default for App {
    fn default() -> Self {
        Self {
            // ... existing fields ...
            lichess_session: None,
            lichess_ws: None,
            auto_move_controller: None,
        }
    }
}
```

## Step 2: Load Session on Startup

In `App::new()` or `main()`:

```rust
// Try to load existing session
match crate::lichess_auth::LichessSession::load_or_create() {
    Ok(session) => {
        log::info!("Loaded Lichess session for: {:?}", session.username);
        app.lichess_session = Some(session);
    }
    Err(e) => {
        log::warn!("No Lichess session: {}", e);
        // User will need to authenticate with --lichess-login
    }
}
```

## Step 3: Update Main Event Loop

In `src/main.rs`, in the main loop, add WebSocket message processing:

```rust
while app.running {
    // ... existing rendering ...
    
    // NEW: Process WebSocket messages if connected
    if let Some(ws_arc) = &app.lichess_ws {
        let ws = ws_arc.lock().unwrap();
        match ws.process_messages() {
            Ok(messages) => {
                for msg in messages {
                    if msg.starts_with("MOVE:") {
                        let uci = &msg[5..];
                        // Set WebSocket move highlight
                        app.game.logic.game_board.set_websocket_last_move(uci);
                        
                        // Add to pending moves for processing
                        // (This would integrate with existing opponent move handling)
                    } else if msg == "GAME_END" {
                        log::info!("Game ended via WebSocket");
                        app.check_game_end_status();
                    } else if msg.starts_with("FEN:") {
                        let fen = &msg[4..];
                        // Sync game state from FEN if needed
                        log::debug!("Position sync: {}", fen);
                    }
                }
            }
            Err(e) => {
                log::error!("WebSocket error: {}", e);
            }
        }
    }
    
    // ... rest of event loop ...
}
```

## Step 4: Start WebSocket When Joining Game

In the code that starts a Lichess game (likely in `app.rs` or `lichess.rs`):

```rust
pub fn start_lichess_websocket_game(&mut self, game_id: &str, player_color: Color) -> Result<(), String> {
    // Generate Socket Request ID
    let sri = crate::lichess_ws::LichessWebSocket::generate_sri();
    log::info!("Generated SRI: {}", sri);
    
    // Create WebSocket connection
    let ws = crate::lichess_ws::LichessWebSocket::new(game_id, &sri)
        .map_err(|e| format!("Failed to connect WebSocket: {}", e))?;
    
    // Store in app
    self.lichess_ws = Some(std::sync::Arc::new(std::sync::Mutex::new(ws)));
    
    // Create channel for opponent moves
    let (move_tx, move_rx) = std::sync::mpsc::channel();
    
    // Create LichessWs opponent
    let opponent = crate::game_logic::opponent::Opponent {
        kind: Some(crate::game_logic::opponent::OpponentKind::LichessWs {
            game_id: game_id.to_string(),
            ws_handle: self.lichess_ws.as_ref().unwrap().clone(),
            move_rx,
        }),
        opponent_will_move: player_color == shakmaty::Color::White,
        color: player_color.other(),
        game_started: true,
        initial_move_count: 0,
        moves_received: 0,
    };
    
    self.game.logic.opponent = Some(opponent);
    
    // Initialize auto-move controller if desired
    let mut auto_move = crate::auto_move::AutoMoveController::new();
    auto_move.set_enabled(false); // Start disabled, can be toggled
    self.auto_move_controller = Some(auto_move);
    
    Ok(())
}
```

## Step 5: Send Moves via WebSocket

When the player makes a move, send it via WebSocket:

```rust
// In the move execution code (likely in app.rs or game_logic/game.rs)
if let Some(opponent) = &mut self.game.logic.opponent {
    if opponent.is_lichess_ws() {
        // Send move via WebSocket
        if let Some(ws_arc) = &self.lichess_ws {
            let ws = ws_arc.lock().unwrap();
            
            // Calculate lag (use auto_move controller if available)
            let lag_ms = if let Some(auto_move) = &self.auto_move_controller {
                if auto_move.is_panic_mode() { 50 } else { 20 }
            } else {
                20
            };
            
            let berserked = self.auto_move_controller
                .as_ref()
                .map(|am| am.is_panic_mode())
                .unwrap_or(false);
            
            ws.send_move(&move_uci, lag_ms, berserked)
                .map_err(|e| format!("Failed to send move: {}", e))?;
        }
    } else {
        // Use existing Lichess HTTP or TCP send logic
        opponent.send_move_to_server(&chess_move, promotion_type);
    }
}
```

## Step 6: Update CLI Arguments

In `src/main.rs`:

```rust
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path for the chess engine
    #[arg(short, long, default_value = "")]
    engine_path: String,
    
    /// Bot thinking depth for chess engine (1-255)
    #[arg(short, long, default_value = "10")]
    depth: u8,
    
    // OPTIONAL: Keep for backward compatibility, or remove (breaking change)
    // #[arg(short, long)]
    // lichess_token: Option<String>,
    
    /// Open browser for Lichess login
    #[arg(long)]
    lichess_login: bool,
    
    /// Disable sound effects
    #[arg(long)]
    no_sound: bool,
}
```

Add login handler:

```rust
fn main() -> AppResult<()> {
    let args = Args::parse();
    
    // Handle Lichess login request
    if args.lichess_login {
        open_lichess_login()?;
        return Ok(());
    }
    
    // ... rest of main ...
}

fn open_lichess_login() -> AppResult<()> {
    println!("Opening Lichess login in your browser...");
    println!("After logging in, return here.");
    
    // Open browser (platform-specific)
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg("https://lichess.org/login")
        .spawn()?;
    
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("https://lichess.org/login")
        .spawn()?;
    
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(&["/C", "start", "https://lichess.org/login"])
        .spawn()?;
    
    println!("\nNote: Session-based authentication is not yet fully implemented.");
    println!("For now, you can still use the Lichess API token method.");
    
    Ok(())
}
```

## Step 7: Update Tick Method

In `src/app.rs`, update the `tick()` method to handle WebSocket opponents:

```rust
pub fn tick(&mut self) {
    // ... existing tick code ...
    
    // For Lichess WebSocket, check for moves
    if let Some(opponent) = self.game.logic.opponent.as_ref() {
        if opponent.is_lichess_ws() {
            // WebSocket moves are processed in main loop
            // Just check for auto-move conditions here
            if let Some(auto_move) = &mut self.auto_move_controller {
                let is_our_turn = self.game.logic.player_turn != opponent.color;
                if auto_move.should_auto_move(is_our_turn) {
                    // Get engine move and execute
                    // (Integrate with existing bot move logic)
                }
            }
        } else if opponent.is_lichess() {
            // Existing HTTP polling logic
            // ...
        }
    }
}
```

## Summary of Changes

**Files to modify:**
1. `src/app.rs` - Add fields, update tick(), add WebSocket game start
2. `src/main.rs` - Update CLI args, add message processing, add login handler
3. `src/lichess.rs` - Add WebSocket game creation option

**Estimated lines changed:**
- app.rs: ~50 lines
- main.rs: ~30 lines
- lichess.rs: ~20 lines

**Breaking changes:**
- Removing `lichess_token` field (if done)
- Removing `-l` CLI argument (if done)

**Backward compatible approach:**
- Keep both HTTP and WebSocket variants
- Add WebSocket as new option
- Keep token-based auth alongside session-based

## Testing

After integration:

```bash
# Start game with WebSocket
cargo run -- --some-new-lichess-ws-flag

# Test auto-move
# (In-game toggle or CLI flag)

# Test browser login
cargo run -- --lichess-login
```

## Next Steps

1. Decide on breaking changes vs. backward compatibility
2. Implement the changes above
3. Test with live Lichess games
4. Update documentation
5. Add tests for WebSocket integration
