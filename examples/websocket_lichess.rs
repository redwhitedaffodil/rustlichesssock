/// Example: WebSocket-based Lichess game integration
/// 
/// This example demonstrates how to use the WebSocket infrastructure
/// for real-time Lichess game communication.

use chess_tui::lichess_ws::LichessWebSocket;
use chess_tui::auto_move::AutoMoveController;
use std::sync::{Arc, Mutex};
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Generate Socket Request ID
    let sri = LichessWebSocket::generate_sri();
    println!("Generated SRI: {}", sri);
    
    // 2. Connect to a Lichess game via WebSocket
    let game_id = "example_game_id"; // Replace with actual game ID
    let ws = Arc::new(Mutex::new(LichessWebSocket::new(game_id, &sri)?));
    println!("Connected to Lichess game: {}", game_id);
    
    // 3. Create channels for move communication
    let (move_tx, move_rx) = channel::<String>();
    
    // 4. Create auto-move controller
    let mut auto_move = AutoMoveController::new();
    auto_move.set_enabled(true);
    println!("Auto-move enabled");
    
    // 5. Spawn thread to process WebSocket messages
    let ws_clone = Arc::clone(&ws);
    let _message_thread = thread::spawn(move || {
        loop {
            let ws = ws_clone.lock().unwrap();
            match ws.process_messages() {
                Ok(messages) => {
                    for msg in messages {
                        if msg.starts_with("MOVE:") {
                            let uci = &msg[5..];
                            println!("Received move: {}", uci);
                            let _ = move_tx.send(uci.to_string());
                        } else if msg == "GAME_END" {
                            println!("Game ended!");
                            break;
                        } else if msg.starts_with("FEN:") {
                            let fen = &msg[4..];
                            println!("Position update: {}", fen);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error processing messages: {}", e);
                }
            }
            drop(ws); // Release lock before sleeping
            thread::sleep(Duration::from_millis(100));
        }
    });
    
    // 6. Example: Send a move
    thread::sleep(Duration::from_secs(1));
    {
        let ws = ws.lock().unwrap();
        match ws.send_move("e2e4", 20, false) {
            Ok(_) => println!("Sent move: e2e4"),
            Err(e) => eprintln!("Failed to send move: {}", e),
        }
    }
    
    // 7. Wait for incoming moves
    println!("Waiting for opponent moves...");
    for _ in 0..5 {
        match move_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(uci) => println!("Opponent played: {}", uci),
            Err(_) => println!("No move received yet..."),
        }
    }
    
    println!("Example complete!");
    Ok(())
}

// To integrate with the full application:
//
// 1. In App struct:
//    pub lichess_ws: Option<Arc<Mutex<LichessWebSocket>>>,
//    pub auto_move: AutoMoveController,
//
// 2. When starting a Lichess game:
//    let sri = LichessWebSocket::generate_sri();
//    let ws = LichessWebSocket::new(&game_id, &sri)?;
//    app.lichess_ws = Some(Arc::new(Mutex::new(ws)));
//
// 3. In the main event loop (tick):
//    if let Some(ws) = &app.lichess_ws {
//        let ws = ws.lock().unwrap();
//        let messages = ws.process_messages()?;
//        for msg in messages {
//            // Handle moves, game end, etc.
//        }
//    }
//
// 4. When player makes a move:
//    if let Some(ws) = &app.lichess_ws {
//        let ws = ws.lock().unwrap();
//        ws.send_move(&uci, 20, false)?;
//    }
