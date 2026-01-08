// ==UserScript==
// @name        Lichess Funnies v36.6 (Speed Optimized + Skill Level 0 Panic) reconnection fix limited
// @version     36.6
// @description Chess automation - speed optimized with smart lag compensation and weakened panic mode
// @author      Michael and Ian (modified with Config Toggles)
// @match       https://lichess.org/*
// @icon        https://www.google.com/s2/favicons?sz=64&domain=lichess.org
// @grant       none
// @run-at      document-start
// @updateURL   https://github.com/mchappychen/lichess-funnies/blob/main/lichess.user.js
// @downloadURL https://github.com/mchappychen/lichess-funnies/blob/main/lichess.user.js
// @require     https://raw.githubusercontent.com/workinworld/stkfish/main/stockfish8.js
// @require     https://code.jquery.com/jquery-3.6.0.min.js
// @require     https://raw.githubusercontent.com/mchappychen/lichess-funnies/main/chess.js
// @require     https://raw.githubusercontent.com/mchappychen/lichess-funnies/main/stockfish.js
// ==/UserScript==
/* globals jQuery, $, Chess, stockfish, lichess, game */

// NOTE: Lichess is a single-page app (SPA). Games often start without a full page reload,
// so we must NOT exit early on the homepage. We simply wait for game DOM nodes to appear.

// --- VPN/Network Lag Compensation ---
let vpnPingOffset = parseInt(localStorage.getItem('vpnPingOffset')) || 0;
let serverLagHistory = [50, 50, 50]; // Start with reasonable default (50ms)
const MAX_LAG_HISTORY = 5;

function updateServerLag(clockData) {
  if (clockData && typeof clockData.lag === 'number') {
    // Server reports in centiseconds (5 = 50ms)
    const lagMs = clockData.lag * 10;
    serverLagHistory.push(lagMs);
    if (serverLagHistory.length > MAX_LAG_HISTORY) {
      serverLagHistory.shift();
    }
    console.log(`[Lag] Server: ${lagMs}ms | History: [${serverLagHistory.join(', ')}]`);
  }
}

function getAverageServerLag() {
  const sum = serverLagHistory.reduce((a, b) => a + b, 0);
  return Math.round(sum / serverLagHistory.length);
}

function getLagCompensation() {
  const avgServerLag = getAverageServerLag();
  const totalLag = avgServerLag + vpnPingOffset;
  const maxReasonable = Math.max(avgServerLag * 2, 100);
  return Math.min(totalLag, maxReasonable);
}

function getPanicLagCompensation() {
  const avgServerLag = getAverageServerLag();
  const totalLag = avgServerLag + vpnPingOffset + 30;
  const maxReasonable = Math.max(avgServerLag * 3, 200);
  return Math.min(totalLag, maxReasonable);
}

// --- Game State Tracking ---
let gameEnded = false;
let lastMoveAcked = false;
let pendingMoveUci = null;

function resetGameState() {
  gameEnded = false;
  lastMoveAcked = false;
  pendingMoveUci = null;
  pendingMove = false;
  isProcessing = false;
  lastMoveSent = null;
  lastMoveSentTime = 0;
  cachedPVs = null;
  cachedPVsFen = null;
  cachedPieceCount = null;
  cachedFen = null;
  serverLagHistory = [50, 50, 50];
  humanTimingStats = { totalMoves: 0, totalTimeMs: 0, engineTimeMs: 0 };
  varietyStats = { pv1: 0, pv2: 0, pv3: 0, pv4: 0, blunders: 0 };
  gameBlunderCount = 0;
  panicModeEnabled = false; // Reset panic mode on new game
  // Reset panic engine state
  panicEngineCalculating = false;
  panicLastRequestTime = 0;
  panicLastFenRequested = null;
  console.log('[State] Game state reset');
}

// --- PANIC ENGINE (chess_engine.js alternative) ---
let panicEngine = null;
let panicEngineReady = false;
let panicCurrentFen = "";
let panicBestMove = null;
let panicModeEnabled = false; // UI-controlled panic mode toggle

// NEW: Panic engine state tracking to prevent freezing
let panicEngineCalculating = false;
let panicLastRequestTime = 0;
let panicLastFenRequested = null;
let panicWatchdogTimer = null;
let panicEngineRetryCount = 0;
const PANIC_TIMEOUT_MS = 500; // Max time to wait for panic engine response
const PANIC_MAX_RETRIES = 3;

function initializePanicEngine() {
  if (panicEngine) return;

  try {
    panicEngine = window.STOCKFISH();

    // --- ADDED: Limited Strength / Skill Level 0 ---
    panicEngine.postMessage("uci");
    panicEngine.postMessage("setoption name Skill Level value 0");
    panicEngine.postMessage("setoption name MultiPV value 1");
    panicEngine.postMessage("setoption name Hash value 16"); // Minimal memory
    // -----------------------------------------------

    panicEngine.onmessage = function(event) {
      if (event && typeof event === 'string' && event.includes("bestmove")) {
        panicBestMove = event.split(" ")[1];
        panicEngineCalculating = false; // Mark engine as free
        panicEngineRetryCount = 0; // Reset retry count on success

        // Clear watchdog timer
        if (panicWatchdogTimer) {
          clearTimeout(panicWatchdogTimer);
          panicWatchdogTimer = null;
        }

        // Guards: Don't send if game ended, already pending, or websocket dead
        if (gameEnded) {
          console.log(`[⚡ PANIC] ❌ Game ended, not sending`);
          return;
        }
        if (pendingMoveUci) {
          console.log(`[⚡ PANIC] ❌ Move already pending: ${pendingMoveUci}`);
          return;
        }
        if (!webSocketWrapper || webSocketWrapper.readyState !== 1) {
          console.log(`[⚡ PANIC] ❌ WebSocket not ready, will retry on reconnect`);
          // Queue for retry on reconnect
          scheduleReconnectRetry();
          return;
        }

        // Only execute if panic mode is enabled via UI button
        if (panicModeEnabled && panicBestMove) {
          const lagClaim = getPanicLagCompensation();
          const clockSecs = getClockSeconds();
          console.log(`[⚡ PANIC ENGINE] Sending: ${panicBestMove} | Clock: ${clockSecs.toFixed(1)}s | Lag: ${lagClaim}ms`);
          webSocketWrapper.send(JSON.stringify({
            t: "move",
            d: { u: panicBestMove, a: currentAck, b: 1, l: lagClaim }
          }));
          pendingMove = false;
          isProcessing = false;
        }
      }
    };
    panicEngineReady = true;
    console.log('[Panic Engine] ✅ Initialized (Skill Level 0)');
  } catch (e) {
    console.error('[Panic Engine] ❌ Failed to initialize:', e);
    panicEngineReady = false;
  }
}

// NEW: Reinitialize panic engine if it becomes unresponsive
function reinitializePanicEngine() {
  console.log('[Panic Engine] 🔄 Reinitializing...');
  panicEngine = null;
  panicEngineReady = false;
  panicEngineCalculating = false;
  panicEngineRetryCount = 0;
  initializePanicEngine();
}

// NEW: Watchdog timeout handler
function handlePanicTimeout() {
  console.log(`[⚡ PANIC] ⚠️ Engine timeout after ${PANIC_TIMEOUT_MS}ms`);
  panicEngineCalculating = false;
  panicEngineRetryCount++;

  if (panicEngineRetryCount >= PANIC_MAX_RETRIES) {
    console.log(`[⚡ PANIC] ❌ Max retries (${PANIC_MAX_RETRIES}) reached, reinitializing engine`);
    reinitializePanicEngine();
    panicEngineRetryCount = 0;
  }

  // Try to recover by triggering a new calculation if still our turn
  if (panicModeEnabled && !gameEnded && !pendingMoveUci) {
    const cgWrap = $('.cg-wrap')[0];
    if (cgWrap) {
      const myCol = cgWrap.classList.contains('orientation-white') ? 'w' : 'b';
      if (game.turn() === myCol) {
        console.log(`[⚡ PANIC] 🔄 Retrying calculation...`);
        setTimeout(() => {
          isProcessing = false;
          pendingMove = false;
          processTurn();
        }, 50);
      }
    }
  }
}

// NEW: Schedule retry on WebSocket reconnect
let reconnectRetryScheduled = false;
function scheduleReconnectRetry() {
  if (reconnectRetryScheduled) return;
  reconnectRetryScheduled = true;

  const checkReconnect = setInterval(() => {
    if (webSocketWrapper && webSocketWrapper.readyState === 1) {
      clearInterval(checkReconnect);
      reconnectRetryScheduled = false;
      console.log(`[⚡ PANIC] 🔄 WebSocket reconnected, retrying...`);

      // Reset state and retry if still in panic mode
      if (panicModeEnabled && !gameEnded) {
        panicEngineCalculating = false;
        isProcessing = false;
        pendingMove = false;
        pendingMoveUci = null;
        setTimeout(processTurn, 100);
      }
    }
  }, 100);

  // Stop checking after 10 seconds
  setTimeout(() => {
    clearInterval(checkReconnect);
    reconnectRetryScheduled = false;
  }, 10000);
}

function panicCalculateMove(fen) {
  // Guard: Don't start new calculation if engine is busy
  if (panicEngineCalculating) {
    const elapsed = Date.now() - panicLastRequestTime;
    if (elapsed < PANIC_TIMEOUT_MS) {
      console.log(`[⚡ PANIC] ⏳ Engine busy (${elapsed}ms), waiting...`);
      return;
    } else {
      // Engine seems stuck, force reset
      console.log(`[⚡ PANIC] ⚠️ Engine stuck for ${elapsed}ms, forcing reset`);
      panicEngineCalculating = false;
    }
  }

  // Guard: Don't recalculate same position
  if (fen === panicLastFenRequested && panicBestMove) {
    console.log(`[⚡ PANIC] ♻️ Using cached move for same position: ${panicBestMove}`);
    // Directly send cached move
    if (panicModeEnabled && !gameEnded && !pendingMoveUci && webSocketWrapper?.readyState === 1) {
      const lagClaim = getPanicLagCompensation();
      webSocketWrapper.send(JSON.stringify({
        t: "move",
        d: { u: panicBestMove, a: currentAck, b: 1, l: lagClaim }
      }));
      pendingMove = false;
      isProcessing = false;
    }
    return;
  }

  if (!panicEngine || !panicEngineReady) {
    initializePanicEngine();
    if (!panicEngineReady) {
      setTimeout(() => panicCalculateMove(fen), 50);
      return;
    }
  }

  // Mark engine as busy and set watchdog
  panicEngineCalculating = true;
  panicLastRequestTime = Date.now();
  panicLastFenRequested = fen;
  panicCurrentFen = fen;
  panicBestMove = null; // Clear old move

  // Set watchdog timer to handle timeout
  if (panicWatchdogTimer) {
    clearTimeout(panicWatchdogTimer);
  }
  panicWatchdogTimer = setTimeout(handlePanicTimeout, PANIC_TIMEOUT_MS);

  try {
    panicEngine.postMessage("stop"); // Stop any ongoing calculation
    panicEngine.postMessage("position fen " + fen);
    panicEngine.postMessage("go depth 1");
    console.log(`[⚡ PANIC] 🔍 Calculating: ${fen.split(' ')[0].substring(0, 20)}...`);
  } catch (e) {
    console.error('[⚡ PANIC] ❌ Engine error:', e);
    panicEngineCalculating = false;
    if (panicWatchdogTimer) {
      clearTimeout(panicWatchdogTimer);
      panicWatchdogTimer = null;
    }
    // Try to reinitialize
    reinitializePanicEngine();
  }
}

// --- socket wrapper ---
let webSocketWrapper = null;
let currentAck = 0;
let lastWebSocketState = null;

const webSocketProxy = new Proxy(window.WebSocket, {
  construct: function(target, args) {
    let ws = new target(...args);
    webSocketWrapper = ws;

    // Wrap send to prevent duplicate moves
    const originalSend = ws.send.bind(ws);
    ws.send = function(data) {
      try {
        const msg = JSON.parse(data);
        if (msg.t === 'move' && msg.d && msg.d.u) {
          // Block if game ended
          if (gameEnded) {
            console.log(`[Send] ❌ Blocked (game ended): ${msg.d.u}`);
            return;
          }
          // Block duplicate of pending move
          if (pendingMoveUci === msg.d.u && !lastMoveAcked) {
            console.log(`[Send] ❌ Blocked (duplicate pending): ${msg.d.u}`);
            return;
          }
          // Track this move
          pendingMoveUci = msg.d.u;
          lastMoveAcked = false;
          console.log(`[Send] ✅ ${msg.d.u} | a: ${msg.d.a} | l: ${msg.d.l}ms`);
        }
      } catch (e) {}
      return originalSend(data);
    };

    // NEW: Track WebSocket state changes for reconnection handling
    ws.addEventListener("open", function() {
      console.log('[WebSocket] ✅ Connected');
      lastWebSocketState = 1;

      // Reset panic state on reconnect
      if (panicModeEnabled) {
        panicEngineCalculating = false;
        pendingMoveUci = null;
        isProcessing = false;
        pendingMove = false;
        console.log('[⚡ PANIC] 🔄 State reset after reconnect');
      }
    });

    ws.addEventListener("close", function() {
      console.log('[WebSocket] ❌ Disconnected');
      lastWebSocketState = 3;
    });

    ws.addEventListener("error", function() {
      console.log('[WebSocket] ⚠️ Error');
      // Reset panic engine state on error
      panicEngineCalculating = false;
    });

    ws.addEventListener("message", function(event) {
      try {
        let msg = JSON.parse(event.data);

        // Track ACK - move was accepted
        if (msg.t === 'ack') {
          lastMoveAcked = true;
          console.log(`[ACK] Move accepted: ${pendingMoveUci}`);
          // Clear pending state
          pendingMoveUci = null;
        }

        // Track game end
        if (msg.t === 'endData' || (msg.d && msg.d.status && msg.d.winner)) {
          gameEnded = true;
          isProcessing = false;
          pendingMove = false;
          panicEngineCalculating = false; // Stop panic engine
          console.log(`[Game] Ended - blocking further moves`);
        }

        // Track move confirmations
        if (msg.t === 'move' && msg.d) {
          if (typeof msg.d.ply !== 'undefined') {
            currentAck = msg.d.ply;
          }

          // Update lag tracking from server response
          if (msg.d.clock) {
            updateServerLag(msg.d.clock);
          }

          // Check for game end in move response
          if (msg.d.status || msg.d.winner) {
            gameEnded = true;
            isProcessing = false;
            pendingMove = false;
            panicEngineCalculating = false;
          }

          // Clear pending after our move is confirmed
          if (msg.d.uci === pendingMoveUci) {
            pendingMoveUci = null;
          }
        }

        // Intercept FEN for panic engine - only if panic mode is enabled via UI AND game not ended
        if (!gameEnded && panicModeEnabled && msg.d && typeof msg.d.fen === "string" && typeof msg.v === "number") {
          if (autoHint && !pendingMoveUci) {
            let interceptedFen = msg.d.fen;
            let isWhitesTurn = msg.v % 2 == 0;
            interceptedFen += isWhitesTurn ? " w" : " b";
            // Check if it's our turn before calculating
            const cgWrap = $('.cg-wrap')[0];
            if (cgWrap) {
              const myCol = cgWrap.classList.contains('orientation-white') ? 'w' : 'b';
              const turnChar = isWhitesTurn ? 'w' : 'b';
              if (myCol === turnChar) {
                console.log(`[⚡ PANIC INTERCEPT] FEN detected, using panic engine`);
                panicCalculateMove(interceptedFen);
              }
            }
          }
        }

        // NEW: Handle reload/reconnect messages
        if (msg.t === 'reload' || msg.t === 'resync') {
          console.log(`[WebSocket] 🔄 ${msg.t} received, resetting panic state`);
          panicEngineCalculating = false;
          pendingMoveUci = null;
          isProcessing = false;
          pendingMove = false;
        }
      } catch (e) {}
    });
    return ws;
  }
});
window.WebSocket = webSocketProxy;

window.lichess = window.site;
window.game = new Chess();

// --- Settings State ---
var autoRun = localStorage.getItem('autorun') ?? "0";
var showArrows = localStorage.getItem('showArrows') !== "0";
var autoHint = autoRun == "1";
var pieceSelectMode = localStorage.getItem('pieceSelectMode') === "1";
var humanMode = localStorage.getItem('humanMode') === "1";
var variedMode = localStorage.getItem('variedMode') !== "0";
var configMode = localStorage.getItem('configMode') || "15s";

// --- CONFIG PRESETS ---
const PRESETS = {
  '7.5s': {
    engineMs: 12,
    varied: {
      maxCpLoss: 900,          // MODIFIED: Allows huge blunders (hanging queen/mate)
      weights: [8, 40, 28, 24],
      maxBlundersPerGame: 50,   // MODIFIED: High limit
      blunderThreshold: 100,
      blunderChance: 0.45,      // MODIFIED: 45% chance to play the bad move
    },
    human: {
      baseDelayMs: 180,
      maxDelayMs: 600,
      premoveDelayMs: 0,
      premoveMaxMs: 10,
      lowPieceDelayMs: 25,
      lowPieceMaxMs: 120,
      premovePieceThreshold: 12,
      lowPieceThreshold: 22,
      quickMoveChance: 0.35,
      quickMoveMs: 0,
      tankChance: 0.008,
      tankMinMs: 250,
      tankMaxMs: 500,
      randomVariance: 0.25,
    }
  },
  '15s': {
    engineMs: 20,
    varied: {
      maxCpLoss: 300,            // Normal safety
      weights: [10, 45, 23, 22],
      maxBlundersPerGame: 10,
      blunderThreshold: 100,
      blunderChance: 0.16,
    },
    human: {
      baseDelayMs: 250,
      maxDelayMs: 800,
      premoveDelayMs: 0,
      premoveMaxMs: 20,
      lowPieceDelayMs: 30,
      lowPieceMaxMs: 150,
      premovePieceThreshold: 10,
      lowPieceThreshold: 20,
      quickMoveChance: 0.25,
      quickMoveMs: 0,
      tankChance: 0.01,
      tankMinMs: 400,
      tankMaxMs: 600,
      randomVariance: 0.27,
    }
  },
  '30s': {
    engineMs: 60,
    varied: {
      maxCpLoss: 200,            // Strict safety
      weights: [30, 55, 10, 5],
      maxBlundersPerGame: 5,
      blunderThreshold: 100,
      blunderChance: 0.08,
    },
    human: {
      baseDelayMs: 500,
      maxDelayMs: 1200,
      premoveDelayMs: 50,
      premoveMaxMs: 150,
      lowPieceDelayMs: 100,
      lowPieceMaxMs: 500,
      premovePieceThreshold: 8,
      lowPieceThreshold: 16,
      quickMoveChance: 0.20,
      quickMoveMs: 60,
      tankChance: 0.05,
      tankMinMs: 1000,
      tankMaxMs: 2000,
      randomVariance: 0.37,
    }
  }
};

// --- Active Config Globals ---
if (!PRESETS[configMode]) configMode = '15s';
let activeHuman = PRESETS[configMode].human;
let activeVaried = PRESETS[configMode].varied;
let activeEngineMs = PRESETS[configMode].engineMs;

function applyConfig(mode) {
  configMode = mode;
  localStorage.setItem('configMode', mode);
  activeHuman = PRESETS[mode].human;
  activeVaried = PRESETS[mode].varied;
  activeEngineMs = PRESETS[mode].engineMs;
  console.log(`[Config] Applied preset: ${mode}`);
}

// --- Stats & State Variables ---
let humanTimingStats = { totalMoves: 0, totalTimeMs: 0, engineTimeMs: 0 };
let varietyStats = { pv1: 0, pv2: 0, pv3: 0, pv4: 0, blunders: 0 };
let gameBlunderCount = 0;
let cachedPVs = null;
let cachedPVsFen = null;
let cachedPieceCount = null;
let cachedFen = null;
let engineReady = false;
let pendingMove = false;
let isProcessing = false;
let lastMoveSent = null;
let lastMoveSentTime = 0;

// --- Helpers ---
function waitForElement(sel) {
  return new Promise(res => {
    const el = document.querySelector(sel);
    if (el) { res(el); return; }
    const obs = new MutationObserver(() => {
      const el = document.querySelector(sel);
      if (el) { obs.disconnect(); res(el); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
}

// --- Clock Parser ---
function getClockSeconds() {
  let clockEl = document.querySelector('.rclock-bottom .time');

  if (!clockEl) {
    const cgWrap = document.querySelector('.cg-wrap');
    if (cgWrap) {
      const isWhite = cgWrap.classList.contains('orientation-white');
      const colorClass = isWhite ? 'rclock-white' : 'rclock-black';
      clockEl = document.querySelector(`.rclock-bottom.${colorClass} .time`);
    }
  }

  if (!clockEl) {
    clockEl = document.querySelector('.rclock.rclock-bottom .time');
  }

  if (!clockEl) {
    return 999;
  }

  const text = clockEl.textContent || '';
  const match = text.match(/(\d+):(\d+)(?:.(\d))?/);
  if (!match) {
    return 999;
  }

  const mins = parseInt(match[1], 10);
  const secs = parseInt(match[2], 10);
  const tenths = match[3] ? parseInt(match[3], 10) / 10 : 0;

  return mins * 60 + secs + tenths;
}

function getArrowCoords(sq, color) {
  const f = sq[0].toLowerCase(), r = sq[1];
  let x = { a: -3.5, b: -2.5, c: -1.5, d: -0.5, e: 0.5, f: 1.5, g: 2.5, h: 3.5 }[f];
  let y = { 1: 3.5, 2: 2.5, 3: 1.5, 4: 0.5, 5: -0.5, 6: -1.5, 7: -2.5, 8: -3.5 }[r];
  if (color == "black") { x = -x; y = -y; }
  return [x, y];
}

function coordsToSquare(x, y, board) {
  const rect = board.getBoundingClientRect();
  const sz = rect.width / 8;
  const isWhite = board.classList.contains('orientation-white');
  let fi = Math.floor((x - rect.left) / sz);
  let ri = Math.floor((y - rect.top) / sz);
  if (isWhite) ri = 7 - ri; else fi = 7 - fi;
  if (fi < 0 || fi > 7 || ri < 0 || ri > 7) return null;
  return 'abcdefgh'[fi] + (ri + 1);
}

function countPieces() {
  const fen = game.fen();
  if (fen === cachedFen && cachedPieceCount !== null) return cachedPieceCount;
  cachedFen = fen;
  cachedPieceCount = (fen.split(' ')[0].match(/[pnbrqkPNBRQK]/g) || []).length;
  return cachedPieceCount;
}

// Checks if a move leads to a draw or 3-fold repetition
function checkDrawishMoves(pvs) {
  const validMoves = [];
  const drawishMoves = [];

  try {
    const tempGame = new Chess();
    // 1. Load history once
    tempGame.load_pgn(game.pgn());

    for (let i = 0; i < pvs.length && i < 4; i++) {
      if (!pvs[i]?.firstMove) continue;

      const uci = pvs[i].firstMove;

      // 2. Simplified Config: Always request Queen promotion.
      // chess.js will only use this if the move actually allows promotion.
      const moveConfig = {
        from: uci.substring(0, 2),
        to: uci.substring(2, 4),
        promotion: 'q'
      };

      const moveResult = tempGame.move(moveConfig);

      if (!moveResult) continue;

      // 3. Check status
      const isDrawish = tempGame.in_threefold_repetition() || tempGame.in_draw();

      if (isDrawish) {
        console.log(`[Anti-Draw] 🚫 ${uci} leads to draw`);
        drawishMoves.push({ ...pvs[i], idx: i });
      } else {
        validMoves.push({ ...pvs[i], idx: i });
      }

      // 4. Undo
      tempGame.undo();
    }
  } catch (e) {
    console.error("[Anti-Draw] Error:", e);
  }

  return { validMoves, drawishMoves };
}

// Optimized Anti-Draw & Selection
function selectVariedMove(pvs) {
  if (!pvs || pvs.length === 0) return null;

  const valid = [];
  const pgn = game.pgn(); // Fetch PGN once

  // --- OPTIMIZED DRAW CHECK ---
  try {
    const tempGame = new Chess();
    tempGame.load_pgn(pgn); // 1. Restore full history for 3-fold detection

    for (let i = 0; i < pvs.length && i < 4; i++) {
      if (!pvs[i]?.firstMove) continue;

      const uci = pvs[i].firstMove;

      // 2. Try move with "Always Queen" promotion
      const moveResult = tempGame.move({
        from: uci.substring(0, 2),
        to: uci.substring(2, 4),
        promotion: 'q' // STRICTLY ENFORCE QUEEN
      });

      // If move is valid (legal), check for draw
      if (moveResult) {
        const isDraw = tempGame.in_threefold_repetition() || tempGame.in_draw();

        // 3. Undo immediately to reset for next loop iteration
        tempGame.undo();

        if (isDraw) {
          console.log(`[Anti-Draw] 🚫 Skipping ${uci} (leads to draw/repetition)`);
          continue; // Skip this move, do not add to valid
        }

        // If we get here, it's valid and not a draw
        valid.push({ ...pvs[i], idx: i });
      }
    }
  } catch (e) {
    console.error("[Anti-Draw] Safety fallback triggered:", e);
    // If checking fails, allow all moves to prevent freeze
    for (let i = 0; i < pvs.length && i < 4; i++) {
       if (pvs[i]) valid.push({ ...pvs[i], idx: i });
    }
  }

  // --- FALLBACKS & SELECTION ---

  // If ALL moves were draws (forced draw), we must play one.
  // Reload valid array with everything.
  if (valid.length === 0) {
    console.log('[Anti-Draw] ⚠️ Forced draw detected. Playing best available.');
    for (let i = 0; i < pvs.length && i < 4; i++) {
      if (pvs[i]) valid.push({ ...pvs[i], idx: i });
    }
  }

  if (valid.length === 0) return null;

  const cfg = activeVaried;
  const topEval = valid[0].evalCp || 0;

  // Blunder Logic
  let allowBlunder = false;
  if (gameBlunderCount < cfg.maxBlundersPerGame && topEval > -100 && Math.random() < cfg.blunderChance) {
    allowBlunder = true;
    console.log('[Vary] 🎲 Blunder allowed! ');
  }

  const candidates = [];

  for (const pv of valid) {
    const cpLoss = topEval - (pv.evalCp || 0);
    const isBlunder = cpLoss >= cfg.blunderThreshold;

    // Safety: Don't blunder into immediate mate (Mate in 1, 2, or 3)
    if (pv.evalType === 'mate' && pv.mateVal !== null && pv.mateVal < 0 && pv.mateVal >= -3) continue;

    if (cpLoss > cfg.maxCpLoss) {
      if (!allowBlunder) continue;
    }

    let weight = cfg.weights[pv.idx] || 5;
    if (cfg.maxCpLoss < 1000) weight = weight - (cpLoss * 0.1);
    weight = Math.max(weight, 3);

    candidates.push({ ...pv, weight, cpLoss, isBlunder });
  }

  // Final Selection
  if (candidates.length === 0) {
    varietyStats.pv1++;
    return { ...valid[0], move: valid[0].firstMove };
  }

  const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
  let rand = Math.random() * totalWeight;
  let selected = candidates[0];

  for (const c of candidates) {
    rand -= c.weight;
    if (rand <= 0) { selected = c; break; }
  }

  // Stats
  if (selected.idx === 0) varietyStats.pv1++;
  else if (selected.idx === 1) varietyStats.pv2++;
  else if (selected.idx === 2) varietyStats.pv3++;
  else varietyStats.pv4++;

  if (selected.isBlunder) {
    gameBlunderCount++;
    varietyStats.blunders++;
    console.log(`[Vary] ⚠️ BLUNDER! (${gameBlunderCount}/${cfg.maxBlundersPerGame})`);
  }

  return { ...selected, move: selected.firstMove };
}

// --- TIMING ---
function calculateHumanDelay(uci) {
  const cfg = activeHuman;
  const clockSecs = getClockSeconds();

  // PANIC MODE via UI button - instant moves
  if (panicModeEnabled) {
    return 0;
  }

  // CAPTURES - always instant
  if (uci && uci.length >= 4) {
    const targetSquare = uci.substring(2, 4);
    const targetPiece = game.get(targetSquare);
    if (targetPiece) {
      return 0;
    }
  }

  const pc = countPieces();

  // Premove mode
  if (pc <= cfg.premovePieceThreshold) {
    const delay = cfg.premoveDelayMs + Math.random() * (cfg.premoveMaxMs - cfg.premoveDelayMs);
    return Math.max(0, Math.round(delay));
  }

  // Low piece mode
  if (pc <= cfg.lowPieceThreshold) {
    const delay = cfg.lowPieceDelayMs + Math.random() * (cfg.lowPieceMaxMs - cfg.lowPieceDelayMs);
    return Math.max(0, Math.round(delay));
  }

  // Normal mode
  let delay = cfg.baseDelayMs;
  delay *= (1 + (Math.random() * 2 - 1) * cfg.randomVariance);

  const roll = Math.random();
  if (roll < cfg.quickMoveChance) {
    delay = cfg.quickMoveMs + Math.random() * 50;
  } else if (roll < cfg.quickMoveChance + cfg.tankChance) {
    delay = cfg.tankMinMs + Math.random() * (cfg.tankMaxMs - cfg.tankMinMs);
  }

  delay = Math.max(0, Math.min(delay, cfg.maxDelayMs));

  if (humanTimingStats.totalMoves > 5) {
    const avg = (humanTimingStats.totalTimeMs + humanTimingStats.engineTimeMs) / humanTimingStats.totalMoves;
    if (avg > 580) delay *= Math.max(0.5, 580 / avg);
  }

  return Math.round(delay);
}

function updateTimingStats(delayMs, engineMs = 0) {
  humanTimingStats.totalMoves++;
  humanTimingStats.totalTimeMs += delayMs;
  humanTimingStats.engineTimeMs += engineMs;
}

function resetStats() {
  humanTimingStats = { totalMoves: 0, totalTimeMs: 0, engineTimeMs: 0 };
  varietyStats = { pv1: 0, pv2: 0, pv3: 0, pv4: 0, blunders: 0 };
  gameBlunderCount = 0;
  cachedPieceCount = null;
  cachedFen = null;
  cachedPVsFen = null;
  pendingMove = false;
  isProcessing = false;
  lastMoveSent = null;
  lastMoveSentTime = 0;
  console.log('[Stats] Reset');
}

// --- Stockfish ---
const SF_THREADS = 4;
const sfListeners = new Set();

stockfish.onmessage = (e) => {
  const data = String(e.data || '');
  if (data === 'readyok') {
    engineReady = true;
    console.log('[Engine] ✅ Ready! ');
  }
  for (const fn of sfListeners) {
    try { fn(e); } catch(x) {}
  }
};

function configureEngine() {
  return new Promise((resolve) => {
    console.log('[Engine] Configuring...');
    stockfish.postMessage('uci');
    stockfish.postMessage('setoption name Threads value 1');
    stockfish.postMessage('setoption name Contempt value 20');
    stockfish.postMessage(`setoption name MultiPV value ${SF_THREADS}`);
    stockfish.postMessage('isready');

    const checkReady = setInterval(() => {
      if (engineReady) {
        clearInterval(checkReady);
        resolve();
      }
    }, 50);

    setTimeout(() => {
      clearInterval(checkReady);
      engineReady = true;
      resolve();
    }, 3000);
  });
}

function parseInfoLine(text) {
  if (!text.startsWith('info ')) return null;
  const mpv = text.match(/multipv (\d+)/);
  const cp = text.match(/score cp (-?\d+)/);
  const mate = text.match(/score mate (-?\d+)/);
  const pv = text.match(/ pv (.+)$/);
  if (!pv) return null;

  let evalCp = null, evalType = 'cp', mateVal = null;
  if (cp) {
    evalCp = parseInt(cp[1], 10);
  } else if (mate) {
    mateVal = parseInt(mate[1], 10);
    evalCp = (mateVal > 0 ? 100000 : -100000) + mateVal;
    evalType = 'mate';
  } else {
    return null;
  }

  return {
    multipv: mpv ? parseInt(mpv[1], 10) : 1,
    evalType, evalCp, mateVal,
    pv: pv[1].trim(),
    firstMove: pv[1].trim().split(' ')[0]
  };
}

function getMultiPV(fen, retryCount = 0) {
  return new Promise((resolve) => {
    // CHECK FOR PANIC MODE via UI button - bypass to faster engine
    if (panicModeEnabled) {
      console.log(`[⚡ PANIC BYPASS] Panic mode enabled via UI - Using panic engine`);
      panicCalculateMove(fen);
      resolve([]);
      return;
    }

    if (!engineReady) {
      setTimeout(() => getMultiPV(fen, retryCount).then(resolve), 100);
      return;
    }

    const pvs = new Map();
    let resolved = false;

    const engineTime = activeEngineMs;

    const handler = (e) => {
      if (resolved) return;
      const txt = String(e.data || '');

      if (txt.startsWith('info ')) {
        const p = parseInfoLine(txt);
        if (p && p.firstMove) pvs.set(p.multipv, p);
      }

      if (txt.startsWith('bestmove')) {
        resolved = true;
        sfListeners.delete(handler);
        const arr = [...pvs.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

        if (arr.length === 0 && retryCount < 3) {
          setTimeout(() => getMultiPV(fen, retryCount + 1).then(resolve), 150);
          return;
        }

        cachedPVs = arr;
        cachedPVsFen = fen;

        resolve(arr);
      }
    };

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        sfListeners.delete(handler);
        const arr = [...pvs.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        cachedPVs = arr;
        cachedPVsFen = fen;
        resolve(arr);
      }
    }, 2000);

    sfListeners.add(handler);
    stockfish.postMessage('stop');
    stockfish.postMessage('position fen ' + fen);
    stockfish.postMessage(`go movetime ${engineTime}`);
  });
}

// --- Drawing ---
const PV_COLORS = [
  { name: 'pv1', hex: '#15781B' },
  { name: 'pv2', hex: '#D35400' },
  { name: 'pv3', hex: '#2980B9' },
  { name: 'pv4', hex: '#8E44AD' }
];

function ensureMarkers() {
  const defs = $('svg.cg-shapes defs')[0];
  if (!defs) return;
  for (const { name, hex } of PV_COLORS) {
    if (!document.getElementById(`arrowhead-${name}`)) {
      defs.innerHTML += `<marker id="arrowhead-${name}" orient="auto" markerWidth="4" markerHeight="8" refX="2.05" refY="2"><path d="M0,0 V4 L3,2 Z" fill="${hex}"></path></marker>`;
    }
  }
}

function drawArrows(pvs) {
  if (!showArrows || !pvs || !pvs.length) return;
  ensureMarkers();
  const layer = $('svg.cg-shapes g')[0];
  if (!layer) return;
  layer.innerHTML = '';

  const seen = new Set();
  const col = $('.cg-wrap')[0].classList.contains('orientation-white') ? 'white' : 'black';
  const topEval = pvs[0]?.evalCp || 0;

  pvs.slice(0, 4).forEach((pv, i) => {
    const m = pv.firstMove;
    if (!m || seen.has(m)) return;
    seen.add(m);

    const pal = PV_COLORS[i];
    const [x1, y1] = getArrowCoords(m.substring(0, 2), col);
    const [x2, y2] = getArrowCoords(m.substring(2, 4), col);

    layer.innerHTML += `<line stroke="${pal.hex}" stroke-width="${0.22 - i*0.015}" stroke-linecap="round" marker-end="url(#arrowhead-${pal.name})" opacity="${1 - i*0.1}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`;

    const cp = pv.evalCp || 0;
    const cpLoss = topEval - cp;
    let label = pv.evalType === 'mate'
      ? `${pv.mateVal > 0 ? '+' : ''}M${pv.mateVal}`
      : `${cp >= 0 ? '+' : ''}${(cp/100).toFixed(1)}`;
    if (i > 0 && cpLoss > 0) label += ` (-${(cpLoss/100).toFixed(1)})`;

    const w = label.length * 0.13 + 0.5;
    layer.innerHTML += `<rect x="${x2 - w/2}" y="${y2 - 0.4}" width="${w}" height="0.34" rx="0.06" fill="#FFF" opacity="0.9" stroke="${pal.hex}" stroke-width="0.02"></rect>`;
    layer.innerHTML += `<text x="${x2}" y="${y2 - 0.18}" fill="${pal.hex}" text-anchor="middle" font-size="0.24" font-weight="bold">${label}</text>`;
  });
}

// --- Execute Move ---
function executeMove(uci) {
  // Guards
  if (!uci) return false;
  if (gameEnded) {
    console.log(`[Exec] ❌ Game ended`);
    return false;
  }
  if (pendingMoveUci) {
    console.log(`[Exec] ❌ Move pending: ${pendingMoveUci}`);
    return false;
  }
  if (!webSocketWrapper || webSocketWrapper.readyState !== 1) {
    console.log(`[Exec] ⚠️ WebSocket not ready, scheduling retry`);
    scheduleReconnectRetry();
    return false;
  }

  const cgWrap = $('.cg-wrap')[0];
  if (!cgWrap) return false;

  const myCol = cgWrap.classList.contains('orientation-white') ? 'w' : 'b';
  if (game.turn() !== myCol) return false;

  const now = Date.now();

  // Duplicate check
  if (uci === lastMoveSent && (now - lastMoveSentTime) < 500) {
    console.log(`[Exec] ❌ Duplicate blocked: ${uci}`);
    return false;
  }

  lastMoveSent = uci;
  lastMoveSentTime = now;

  // Smart lag compensation - use panic compensation when panic mode enabled
  const lagClaim = panicModeEnabled ? getPanicLagCompensation() : getLagCompensation();

  console.log(`[Exec] ✅ Sending: ${uci} | Lag: ${lagClaim}ms (server avg: ${getAverageServerLag()}ms)${panicModeEnabled ? ' [PANIC]' : ''}`);
  webSocketWrapper.send(JSON.stringify({ t: "move", d: { u: uci, a: currentAck, b: panicModeEnabled ? 1 : 0, l: lagClaim } }));
  pendingMove = false;
  isProcessing = false;
  return true;
}

function executeMoveHumanized(uci, engineMs = 0) {
  if (!uci) { isProcessing = false; return; }

  // PANIC MODE via UI button - direct execute
  if (panicModeEnabled) {
    console.log(`[⚡ PANIC MODE] ${uci} - using direct execute`);
    executeMove(uci);
    return;
  }

  // Instant capture
  if (uci.length >= 4) {
    const targetSquare = uci.substring(2, 4);
    const targetPiece = game.get(targetSquare);
    if (targetPiece) {
      const clockSecs = getClockSeconds();
      console.log(`[⚡ CAPTURE] ${uci} | Clock: ${clockSecs.toFixed(1)}s | Engine: ${engineMs}ms`);
      executeMove(uci);
      return;
    }
  }

  const delay = calculateHumanDelay(uci);
  const clockSecs = getClockSeconds();
  updateTimingStats(delay, engineMs);
  console.log(`[Human] ${uci} | Clock: ${clockSecs.toFixed(1)}s | Delay: ${delay}ms | Engine: ${engineMs}ms`);

  if (delay <= 0) executeMove(uci);
  else setTimeout(() => executeMove(uci), delay);
}

// --- Main Selection ---
function selectBestMove(pvs) {
  if (!pvs || pvs.length === 0) return null;

  let result = null;
  if (variedMode) result = selectVariedMove(pvs);

  if (!result || !result.move) {
    if (pvs[0] && pvs[0].firstMove) {
      result = { ...pvs[0], move: pvs[0].firstMove, idx: 0 };
      varietyStats.pv1++;
    }
  }
  return result;
}

function actOnHint(data, engineMs = 0) {
  if (!data || !data.move) { isProcessing = false; return; }
  const uci = data.move;

  const colorIdx = data.idx || 0;
  const cgWrap = $('.cg-wrap')[0];
  if (cgWrap && showArrows) {
    const col = cgWrap.classList.contains('orientation-white') ? 'white' : 'black';
    const [x1, y1] = getArrowCoords(uci.substring(0, 2), col);
    const [x2, y2] = getArrowCoords(uci.substring(2, 4), col);
    const layer = $('svg.cg-shapes g')[0];
    if (layer) layer.innerHTML += `<line stroke="${PV_COLORS[colorIdx].hex}" stroke-width="0.3" stroke-linecap="round" marker-end="url(#arrowhead-pv1)" opacity="1" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`;
  }

  if (!autoHint) { isProcessing = false; return; }
  if (!webSocketWrapper || !cgWrap) { isProcessing = false; return; }

  const myCol = cgWrap.classList.contains('orientation-white') ? 'w' : 'b';
  if (game.turn() !== myCol) { isProcessing = false; return; }

  if (humanMode) executeMoveHumanized(uci, engineMs);
  else executeMove(uci);
}

// --- Process Turn ---
async function processTurn() {
  // Guards
  if (gameEnded) return;
  if (isProcessing) return;
  if (pendingMoveUci) return;

  const cgWrap = $('.cg-wrap')[0];
  if (!cgWrap) return;

  const myCol = cgWrap.classList.contains('orientation-white') ? 'w' : 'b';
  if (game.turn() !== myCol) return;

  if (!autoHint) return;

  isProcessing = true;
  pendingMove = true;

  const clockSecs = getClockSeconds();
  const currentFen = game.fen();
  const t0 = performance.now();

  // PANIC MODE CHECK via UI button - bypass all logic, use panic engine
  if (panicModeEnabled) {
    console.log(`[⚡ PANIC MODE] Clock: ${clockSecs.toFixed(1)}s - Using panic engine (UI enabled)`);
    panicCalculateMove(currentFen);
    // Don't wait - panic engine will handle move execution
    return;
  }

  try {
    let pvs;
    let engineTime;

    // Normal mode - use full engine
    pvs = await getMultiPV(currentFen);
    engineTime = Math.round(performance.now() - t0);
    console.log(`[Engine] Clock: ${clockSecs.toFixed(1)}s | Took: ${engineTime}ms`);

    if (!pvs || pvs.length === 0) {
      isProcessing = false;
      pendingMove = false;
      setTimeout(processTurn, 500);
      return;
    }

    if (!pieceSelectMode) drawArrows(pvs);

    if (!pieceSelectMode) {
      const chosen = selectBestMove(pvs);
      if (chosen && chosen.move) actOnHint(chosen, engineTime);
      else { isProcessing = false; pendingMove = false; }
    } else {
      isProcessing = false;
      pendingMove = false;
    }
  } catch (err) {
    isProcessing = false;
    pendingMove = false;
  }
}

// --- Sync game state ---
function syncGameState() {
  try {
    game = new Chess();
    const moves = $('kwdb, u8t');
    for (let i = 0; i < moves.length; i++) {
      const moveText = moves[i].textContent.replace('✓', '').trim();
      if (moveText) try { game.move(moveText); } catch(e) {}
    }
  } catch(e) {}
}

// --- Piece Select Mode ---
function setupPieceSelectMode() {
  const board = $('.cg-wrap')[0];
  if (!board) return;

  board.addEventListener('click', async (e) => {
    if (!pieceSelectMode) return;
    const sq = coordsToSquare(e.clientX, e.clientY, board);
    if (!sq) return;
    const myCol = board.classList.contains('orientation-white') ? 'w' : 'b';
    if (game.turn() !== myCol) return;
    const piece = game.get(sq);
    if (!piece || piece.color !== myCol) return;

    if (!cachedPVs) cachedPVs = await getMultiPV(game.fen());
    const moves = cachedPVs.filter(p => p.firstMove?.substring(0, 2) === sq);
    if (moves.length > 0) {
      const best = moves[0].firstMove;
      setTimeout(() => humanMode ? executeMoveHumanized(best) : executeMove(best), 50);
    }
  });
}

// --- Floating UI Dock ---
function createBottomDock() {
  const existing = document.getElementById('lf-bottom-dock-content');
  if (existing) return existing;

  const root = document.createElement('div');
  root.id = 'lf-bottom-dock';
  root.style.cssText = [
    'position: fixed',
    'left: 50%',
    'bottom: 8px',
    'transform: translateX(-50%)',
    'z-index: 999999',
    'pointer-events: none'
  ].join(';');

  const bar = document.createElement('div');
  bar.style.cssText = [
    'pointer-events: auto',
    'display: flex',
    'align-items: center',
    'gap: 6px',
    'padding: 6px 8px',
    'background: rgba(0,0,0,0.35)',
    'border-radius: 12px',
    'backdrop-filter: blur(4px)',
    'max-width: calc(100vw - 16px)',
    'overflow-x: auto'
  ].join(';');

  const toggle = document.createElement('button');
  toggle.classList.add('fbt');
  toggle.style.fontSize = '10px';
  toggle.style.padding = '2px 6px';
  toggle.style.minWidth = '28px';

  const content = document.createElement('div');
  content.id = 'lf-bottom-dock-content';
  content.style.cssText = 'display: flex;align-items:center;gap: 6px;';

  bar.appendChild(toggle);
  bar.appendChild(content);
  root.appendChild(bar);
  document.body.appendChild(root);

  let collapsed = localStorage.getItem('lfDockCollapsed') === '1';
  function render() {
    content.style.display = collapsed ? 'none' : 'flex';
    toggle.textContent = collapsed ? '▲' : '▼';
    toggle.title = collapsed ? 'Expand' : 'Minimize';
    localStorage.setItem('lfDockCollapsed', collapsed ? '1' : '0');
  }
  toggle.onclick = () => { collapsed = !collapsed; render(); };
  render();

  return content;
}

// NEW: Global panic mode watchdog - runs every 1 second to detect frozen state
function startPanicWatchdog() {
  setInterval(() => {
    if (!panicModeEnabled || gameEnded) return;

    // Check if panic engine is stuck
    if (panicEngineCalculating) {
      const elapsed = Date.now() - panicLastRequestTime;
      if (elapsed > PANIC_TIMEOUT_MS * 2) {
        console.log(`[⚡ PANIC WATCHDOG] Engine stuck for ${elapsed}ms, forcing recovery`);
        panicEngineCalculating = false;
        panicEngineRetryCount++;

        if (panicEngineRetryCount >= PANIC_MAX_RETRIES) {
          reinitializePanicEngine();
        }

        // Retry if it's our turn
        const cgWrap = $('.cg-wrap')[0];
        if (cgWrap && !pendingMoveUci) {
          const myCol = cgWrap.classList.contains('orientation-white') ? 'w' : 'b';
          if (game.turn() === myCol) {
            isProcessing = false;
            pendingMove = false;
            processTurn();
          }
        }
      }
    }

    // Check for stuck processing state
    if (isProcessing && !panicEngineCalculating && !pendingMoveUci) {
      console.log(`[⚡ PANIC WATCHDOG] Processing stuck, resetting`);
      isProcessing = false;
      pendingMove = false;

      const cgWrap = $('.cg-wrap')[0];
      if (cgWrap) {
        const myCol = cgWrap.classList.contains('orientation-white') ? 'w' : 'b';
        if (game.turn() === myCol) {
          processTurn();
        }
      }
    }
  }, 1000);
}

// --- Main ---
async function run() {
  console.log('[Init] Starting...');

  // Initialize panic engine early
  initializePanicEngine();

  // NEW: Start panic watchdog
  startPanicWatchdog();

  await configureEngine();
  setupPieceSelectMode();
  syncGameState();

  // Initial Turn Check
  const cgWrap = $('.cg-wrap')[0];
  if (cgWrap) {
    const myCol = cgWrap.classList.contains('orientation-white') ? 'w' : 'b';
    if (game.turn() === myCol && autoHint) setTimeout(processTurn, 500);
  }

  // Move observer
  const moveObs = new MutationObserver((muts) => {
    for (const mut of muts) {
      if (mut.addedNodes.length === 0) continue;
      if (mut.addedNodes[0].tagName === "I5Z") continue;

      const lastEl = $('l4x')[0]?.lastChild;
      if (!lastEl) continue;

      try { game.move(lastEl.textContent); } catch (e) {}

      // CLEAR ALL CACHES - position changed
      cachedPVs = null;
      cachedPVsFen = null;
      cachedPieceCount = null;
      cachedFen = null;
      isProcessing = false;
      pendingMove = false;

      // Reset duplicate move tracking on position change
      lastMoveSent = null;
      lastMoveSentTime = 0;
      pendingMoveUci = null;
      lastMoveAcked = false;

      // Reset panic engine state on new position
      panicEngineCalculating = false;
      panicLastFenRequested = null;
      panicBestMove = null;

      setTimeout(processTurn, 100);
    }
  });

  waitForElement('rm6').then((el) => {
    moveObs.observe(el, { childList: true, subtree: true });
    syncGameState();
    setTimeout(processTurn, 500);
  });

  const endObs = new MutationObserver(() => {
    if ($('div.rcontrols')[0]?.textContent.includes("Rematch")) {
      resetGameState();
      if (window.lichess?.socket?.send) window.lichess.socket.send("rematch-yes");
      setTimeout(() => { try { $('a.fbt[href^="/?hook_like"]')[0]?.click(); } catch(e) {} }, 1000);
      endObs.disconnect();
    }
  });
  if ($('div.rcontrols')[0]) endObs.observe($('div.rcontrols')[0], { childList: true, subtree: true });

  setInterval(() => {
    if (!gameEnded && !isProcessing && !pendingMoveUci && autoHint && !pieceSelectMode) {
      const cg = $('.cg-wrap')[0];
      if (cg) {
        const myCol = cg.classList.contains('orientation-white') ? 'w' : 'b';
        if (game.turn() === myCol) processTurn();
      }
    }
  }, 3000);

  // --- UI BUTTONS ---
  const btnCont = createBottomDock() || $('div.ricons')[0];

  // 1. Hint
  const hintBtn = document.createElement('button');
  hintBtn.innerText = 'Hint';
  hintBtn.classList.add('fbt');
  hintBtn.onclick = () => {
    getMultiPV(game.fen()).then(pvs => { if (pvs.length) { cachedPVs = pvs; drawArrows(pvs); } });
  };
  if (btnCont) btnCont.appendChild(hintBtn);

  // 2. Auto Toggle
  const autoBtn = document.createElement('button');
  autoBtn.innerText = autoHint ? 'Auto-ON' : 'Auto-OFF';
  autoBtn.classList.add('fbt');
  autoBtn.style.backgroundColor = autoHint ? "green" : "";
  autoBtn.onclick = () => {
    autoHint = !autoHint;
    localStorage.setItem('autorun', autoHint ? "1" : "0");
    autoBtn.innerText = autoHint ? 'Auto-ON' : 'Auto-OFF';
    autoBtn.style.backgroundColor = autoHint ? "green" : "";
    if (autoHint) { isProcessing = false; processTurn(); }
  };
  if (btnCont) btnCont.appendChild(autoBtn);

  // 3. Config Toggle
  const CFG_ORDER = ['7.5s', '15s', '30s'];
  const CFG_COLORS = { '7.5s': "#8E44AD", '15s': "#A93226", '30s': "#229954" };

  const configBtn = document.createElement('button');
  configBtn.innerText = `Cfg: ${configMode}`;
  configBtn.classList.add('fbt');
  configBtn.style.backgroundColor = CFG_COLORS[configMode] || "#229954";
  configBtn.style.fontSize = "10px";
  configBtn.onclick = () => {
    const idx = Math.max(0, CFG_ORDER.indexOf(configMode));
    const newMode = CFG_ORDER[(idx + 1) % CFG_ORDER.length];
    applyConfig(newMode);
    configBtn.innerText = `Cfg: ${newMode}`;
    configBtn.style.backgroundColor = CFG_COLORS[newMode] || "#229954";
  };
  if (btnCont) btnCont.appendChild(configBtn);

  // 4. Arrow Toggle
  const arrowBtn = document.createElement('button');
  arrowBtn.innerText = showArrows ? 'Arr-ON' : 'Arr-OFF';
  arrowBtn.classList.add('fbt');
  arrowBtn.style.fontSize = "10px";
  arrowBtn.style.opacity = showArrows ? "1" : "0.5";
  arrowBtn.onclick = () => {
    showArrows = !showArrows;
    localStorage.setItem('showArrows', showArrows ? "1" : "0");
    arrowBtn.innerText = showArrows ? 'Arr-ON' : 'Arr-OFF';
    arrowBtn.style.opacity = showArrows ? "1" : "0.5";
    if (!showArrows) { const l = $('svg.cg-shapes g')[0]; if (l) l.innerHTML = ''; }
  };
  if (btnCont) btnCont.appendChild(arrowBtn);

  // 5. Piece Mode
  const pieceBtn = document.createElement('button');
  pieceBtn.innerText = pieceSelectMode ? 'Piece-ON' : 'Piece-OFF';
  pieceBtn.classList.add('fbt');
  pieceBtn.style.fontSize = "9px";
  pieceBtn.style.backgroundColor = pieceSelectMode ? "#2980B9" : "";
  pieceBtn.onclick = () => {
    pieceSelectMode = !pieceSelectMode;
    localStorage.setItem('pieceSelectMode', pieceSelectMode ? "1" : "0");
    pieceBtn.innerText = pieceSelectMode ? 'Piece-ON' : 'Piece-OFF';
    pieceBtn.style.backgroundColor = pieceSelectMode ? "#2980B9" : "";
  };
  if (btnCont) btnCont.appendChild(pieceBtn);

  // 6. Human Mode
  const humanBtn = document.createElement('button');
  humanBtn.innerText = humanMode ? 'Human-ON' : 'Human-OFF';
  humanBtn.classList.add('fbt');
  humanBtn.style.fontSize = "9px";
  humanBtn.style.backgroundColor = humanMode ? "#E74C3C" : "";
  humanBtn.onclick = () => {
    humanMode = !humanMode;
    localStorage.setItem('humanMode', humanMode ? "1" : "0");
    humanBtn.innerText = humanMode ? 'Human-ON' : 'Human-OFF';
    humanBtn.style.backgroundColor = humanMode ? "#E74C3C" : "";
    if (humanMode) resetStats();
  };
  if (btnCont) btnCont.appendChild(humanBtn);

  // 7. Vary Mode
  const varyBtn = document.createElement('button');
  varyBtn.innerText = variedMode ? 'Vary-ON' : 'Vary-OFF';
  varyBtn.classList.add('fbt');
  varyBtn.style.fontSize = "9px";
  varyBtn.style.backgroundColor = variedMode ? "#9B59B6" : "";
  varyBtn.onclick = () => {
    variedMode = !variedMode;
    localStorage.setItem('variedMode', variedMode ? "1" : "0");
    varyBtn.innerText = variedMode ? 'Vary-ON' : 'Vary-OFF';
    varyBtn.style.backgroundColor = variedMode ? "#9B59B6" : "";
  };
  if (btnCont) btnCont.appendChild(varyBtn);

  // 8. PANIC MODE BUTTON (NEW - replaces threshold-based activation)
  const panicBtn = document.createElement('button');
  panicBtn.innerText = panicModeEnabled ? '⚡PANIC-ON' : '⚡PANIC';
  panicBtn.classList.add('fbt');
  panicBtn.style.fontSize = "9px";
  panicBtn.style.backgroundColor = panicModeEnabled ? "#E74C3C" : "";
  panicBtn.style.fontWeight = "bold";
  panicBtn.title = "Enable instant moves using fast panic engine (depth 2)";
  panicBtn.onclick = () => {
    panicModeEnabled = !panicModeEnabled;
    panicBtn.innerText = panicModeEnabled ? '⚡PANIC-ON' : '⚡PANIC';
    panicBtn.style.backgroundColor = panicModeEnabled ? "#E74C3C" : "";
    console.log(`[⚡ PANIC] ${panicModeEnabled ? 'ENABLED' : 'DISABLED'} via UI button`);

    // If enabling panic mode and it's our turn, immediately trigger
    if (panicModeEnabled && autoHint) {
      isProcessing = false;
      pendingMove = false;
      processTurn();
    }
  };
  if (btnCont) btnCont.appendChild(panicBtn);

  // 9. VPN Lag Offset Button
  const lagBtn = document.createElement('button');
  const updateLagBtnText = () => {
    const avgLag = getAverageServerLag();
    const normalClaim = getLagCompensation();
    const panicClaim = getPanicLagCompensation();
    lagBtn.innerText = `+${vpnPingOffset}`;
    lagBtn.style.backgroundColor = vpnPingOffset > 0 ? "#1ABC9C" : "";
    lagBtn.title = [
      `Server avg: ${avgLag}ms`,
      `VPN offset: +${vpnPingOffset}ms`,
      `Normal claim: ${normalClaim}ms`,
      `Panic claim: ${panicClaim}ms`
    ].join('\n');
  };
  lagBtn.classList.add('fbt');
  lagBtn.style.fontSize = "9px";
  updateLagBtnText();
  lagBtn.onclick = () => {
    const offsets = [0, 30, 50, 80, 100, 150];
    const idx = offsets.indexOf(vpnPingOffset);
    vpnPingOffset = offsets[(idx + 1) % offsets.length];
    localStorage.setItem('vpnPingOffset', vpnPingOffset);
    updateLagBtnText();
    console.log(`[Lag] VPN: +${vpnPingOffset}ms | Server: ${getAverageServerLag()}ms | Claim: ${getLagCompensation()}ms`);
  };
  if (btnCont) btnCont.appendChild(lagBtn);

  // Stats Display
  const stats = document.createElement('span');
  stats.id = 'human-stats';
  stats.style.cssText = 'font-size: 9px;color:#888;margin-left:5px;display:none;';
  if (btnCont) btnCont.appendChild(stats);

  setInterval(() => {
    const el = document.getElementById('human-stats');
    if (!el) return;
    updateLagBtnText(); // Update lag button too
    if (humanMode && humanTimingStats.totalMoves > 0) {
      const avg = Math.round((humanTimingStats.totalTimeMs + humanTimingStats.engineTimeMs) / humanTimingStats.totalMoves);
      const proj = Math.round(30000 / avg);
      const tot = varietyStats.pv1 + varietyStats.pv2 + varietyStats.pv3 + varietyStats.pv4;
      const pv1p = tot > 0 ? Math.round(varietyStats.pv1 / tot * 100) : 0;
      el.textContent = variedMode
        ? `${avg}ms|${configMode}|PV1: ${pv1p}%|⚠️${gameBlunderCount}${panicModeEnabled ? '|⚡' : ''}`
        : `${avg}ms|${configMode}${panicModeEnabled ? '|⚡' : ''}`;
      el.style.display = 'inline';
    } else {
      el.style.display = 'none';
    }
  }, 1000);

  $('.fbt').on('mousedown', function() {
    this.style.border = '6px solid blue';
    setTimeout((a) => { a.style.border = ''; }, 500, this);
  });

  $(document).on("keydown", (e) => {
    if (e.key === "w") { hintBtn.click(); autoBtn.click(); }
    if (e.key === "p") pieceBtn.click();
    if (e.key === "h") humanBtn.click();
    if (e.key === "v") varyBtn.click();
    if (e.key === "l") lagBtn.click();
  });
}

waitForElement('rm6').then(() => run());
