# WebSocket-Based Lichess Integration

This document describes the WebSocket infrastructure added to support real-time Lichess game communication.

## Overview

The codebase now includes complete WebSocket infrastructure for real-time Lichess integration, following the patterns from `toimplement_directplay.js`. This provides:

1. **Real-time move detection** via WebSocket connections (no HTTP polling)
2. **Move highlights** showing last moves in real-time
3. **Auto-move functionality** with engine integration
4. **Session-based authentication** (infrastructure ready)

## Architecture

### Core Modules

#### 1. `lichess_ws.rs` - WebSocket Client
- **LichessWebSocket**: Main WebSocket client for Lichess
  - Connects to `wss://socket5.lichess.org/play/{game_id}/v6?sri={sri}`
  - Manages connection state with atomic flags
  - Handles all Lichess message types: `move`, `ack`, `endData`, `reload`, `resync`, `crowd`

- **send_move()**: Send moves with guards
  - Prevents sending if game ended
  - Blocks duplicate moves
  - Includes lag compensation (ms)
  - JSON format: `{ t: "move", d: { u: uci, a: ack, b: berserked, l: lag_ms } }`

- **process_messages()**: Handle incoming messages
  - `ack` - clear pending move, log acceptance
  - `endData` - set game_ended flag, send GAME_END signal
  - `move` - extract UCI for highlighting, extract FEN for sync
  - `reload`/`resync` - reset pending state
  - Returns Vec<String> of processed messages

#### 2. `lichess_auth.rs` - Session Management
- **LichessSession**: Manages Lichess authentication
  - `session_id`, `csrf_token`, `username`
  - `load_or_create()` - load existing session or prompt login
  - `validate()` - check session against API
  - `generate_sri()` - generate 12-char alphanumeric Socket Request ID
  - Session storage: `~/.config/chess-tui/lichess_session.json`

#### 3. `auto_move.rs` - Auto-Move Controller
- **AutoMoveController**: Controls automatic move execution
  - `enabled` - toggle auto-move on/off
  - `panic_mode` - emergency fast-move mode
  - `engine_calculating` - prevent double-execution
  - `should_auto_move()` - check conditions before executing
  - `execute_auto_move()` - send move with lag compensation
    - Duplicate prevention with 500ms window
    - Lag: 50ms (panic mode) or 20ms (normal)
    - Tracks last move sent/time

### Integration Points

#### GameBoard Enhancements
```rust
pub struct GameBoard {
    // ... existing fields ...
    
    /// WebSocket move highlight (from, to)
    pub last_ws_move: Option<(Square, Square)>,
    
    /// Timestamp of last WebSocket move
    pub last_ws_move_time: Option<std::time::Instant>,
}
```

- `set_websocket_last_move(uci)` - Parse UCI string and set highlight
- UI rendering prioritizes WebSocket moves over move history

#### Opponent Types
```rust
pub enum OpponentKind {
    Tcp(TcpStream),
    Lichess { ... },          // HTTP polling (legacy)
    LichessWs {               // WebSocket (new)
        game_id: String,
        ws_handle: Arc<Mutex<LichessWebSocket>>,
        move_rx: Receiver<String>,
    },
}
```

Helper methods:
- `is_lichess_ws()` - check if opponent is WebSocket-based
- `is_lichess()` - check if opponent is HTTP polling-based
- `is_tcp_multiplayer()` - check if opponent is TCP-based

## Message Flow

### Outgoing (Player → Lichess)
1. Player makes move
2. `AutoMoveController::execute_auto_move()` OR manual send
3. `LichessWebSocket::send_move(uci, lag_ms, berserked)`
4. Guards check: game_ended, pending_move, WebSocket ready
5. Send JSON: `{"t":"move","d":{"u":"e2e4","a":0,"b":0,"l":20}}`
6. Track pending move until ack received

### Incoming (Lichess → Player)
1. WebSocket receives message
2. `LichessWebSocket::process_messages()` parses JSON
3. Based on message type `t`:
   - `"ack"` → Clear pending move, log acceptance
   - `"move"` → Extract UCI/FEN, send to move_rx channel
   - `"endData"` → Set game_ended flag, send GAME_END
   - `"reload"`/`"resync"` → Reset state
4. Main loop processes messages from move_rx
5. Update game state, highlight moves, switch turns

## State Management

### Thread-Safe Atomic State
```rust
current_ack: Arc<AtomicU32>           // Track ply for acknowledgments
game_ended: Arc<AtomicBool>           // Game end flag
pending_move: Arc<Mutex<Option<String>>>  // Duplicate prevention
last_move_acked: Arc<AtomicBool>      // Move confirmation
```

### Guards and Safety
- **Game Ended**: Block all moves if `game_ended` is true
- **Pending Move**: Only one move can be in-flight at a time
- **Duplicate Prevention**: 500ms window to block repeated moves
- **WebSocket State**: Check connection ready before sending

## Lag Compensation

Following `toimplement_directplay.js` patterns:

```rust
let lag_ms = if panic_mode {
    50  // Panic mode: claim 50ms lag for faster play
} else {
    20  // Normal mode: claim 20ms lag
};
```

Lag is included in every move message to optimize server-side timing.

## Usage Example

```rust
// Create WebSocket connection
let sri = LichessWebSocket::generate_sri();
let ws = LichessWebSocket::new(&game_id, &sri)?;

// Send a move
ws.send_move("e2e4", 20, false)?;

// Process incoming messages
let messages = ws.process_messages()?;
for msg in messages {
    if msg.starts_with("MOVE:") {
        let uci = &msg[5..];
        game_board.set_websocket_last_move(uci);
    } else if msg == "GAME_END" {
        // Handle game end
    }
}
```

## Integration Status

### ✅ Completed
- [x] WebSocket client with full message handling
- [x] Session management infrastructure
- [x] Auto-move controller with lag compensation
- [x] GameBoard WebSocket move tracking
- [x] Opponent type variants (LichessWs)
- [x] UI prioritization of WebSocket moves
- [x] All tests passing

### 🔨 Remaining Work
- [ ] App struct integration (add lichess_ws, lichess_session fields)
- [ ] Main loop WebSocket message processing
- [ ] CLI argument updates (remove token requirement)
- [ ] Browser-based login flow implementation
- [ ] Full end-to-end testing with live Lichess games
- [ ] Documentation and examples

## Dependencies Added

```toml
tungstenite = { version = "0.21", features = ["native-tls"] }
url = "2.5"
rand = "0.8"
```

## Testing

All existing tests pass:
```bash
cargo test --no-default-features --features chess-tui
```

Build succeeds without sound feature (for CI environments):
```bash
cargo build --no-default-features --features chess-tui
```

## Security Notes

1. **Session Storage**: Sessions stored in `~/.config/chess-tui/lichess_session.json`
2. **WebSocket TLS**: Uses native-tls for secure connections
3. **Token Migration**: Infrastructure supports moving from API tokens to session-based auth
4. **State Guards**: Atomic operations prevent race conditions in WebSocket handling

## Performance

- **Non-blocking I/O**: WebSocket operations are non-blocking
- **Atomic State**: Lock-free state checks where possible
- **Efficient Parsing**: JSON parsing only on message receive
- **Minimal Allocations**: Reuses buffers and strings where possible

## Reference Implementation

This implementation follows patterns from `toimplement_directplay.js`:
- WebSocket proxy pattern (lines 295-441)
- Move execution guards (lines 1068-1108)
- Lag compensation (lines 1094-1108)
- State management (currentAck, pendingMoveUci, gameEnded, lastMoveAcked)

## Next Steps

To complete the integration:

1. **App Integration**: Add WebSocket fields to App struct
2. **Main Loop**: Process WebSocket messages each tick
3. **Game Start**: Initialize WebSocket when joining/starting Lichess games
4. **Move Handling**: Route player moves through WebSocket
5. **CLI Updates**: Implement browser-based login flow
6. **Testing**: End-to-end testing with live games

## Contributing

When extending this infrastructure:
- Maintain thread safety with Arc/Mutex/Atomic types
- Follow the guard pattern (check conditions before operations)
- Log extensively for debugging (info, warn, error levels)
- Keep message handling stateless where possible
- Add tests for new functionality
