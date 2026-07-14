import express from 'express';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Table } from './engine/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TURN_SECONDS = 45; // auto-act if a player takes too long
const AUTO_DEAL_MS = 6000; // pause between hands
const EMPTY_TABLE_TTL_MS = 1000 * 60 * 30; // clean up idle tables after 30 min

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// code -> room. A room wraps one Table plus connection bookkeeping.
const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom({ startingStack, smallBlind, bigBlind }) {
  const code = makeCode();
  const room = {
    code,
    table: new Table({ id: code, startingStack, smallBlind, bigBlind }),
    sockets: new Map(), // playerId -> ws
    hostId: null,
    turnTimer: null,
    dealTimer: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room) {
  room.lastActivity = Date.now();
  const pub = room.table.publicState();
  for (const [pid, ws] of room.sockets) {
    send(ws, {
      type: 'state',
      public: pub,
      private: room.table.privateState(pid),
      isHost: pid === room.hostId,
    });
  }
  armTurnTimer(room);
}

// Auto-act for a player who runs out the clock: check if possible, else fold.
function armTurnTimer(room) {
  clearTimeout(room.turnTimer);
  const cur = room.table.currentPlayer();
  if (!cur) return;
  room.turnTimer = setTimeout(() => {
    const still = room.table.currentPlayer();
    if (!still || still.id !== cur.id) return;
    const la = room.table.legalActions(cur.id);
    try {
      if (la?.check) room.table.act(cur.id, { type: 'check' });
      else room.table.act(cur.id, { type: 'fold' });
    } catch { /* hand may have moved on */ }
    afterAction(room);
  }, TURN_SECONDS * 1000);
}

// After any hand-advancing action, broadcast and, if the hand ended, schedule the next.
function afterAction(room) {
  broadcast(room);
  const h = room.table.hand;
  if (h && h.complete) {
    clearTimeout(room.dealTimer);
    room.dealTimer = setTimeout(() => {
      if (room.table.eligibleForHand().length >= 2) {
        try { room.table.startHand(); afterAction(room); } catch { broadcast(room); }
      }
    }, AUTO_DEAL_MS);
  }
}

wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      handle(ws, msg);
    } catch (err) {
      send(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room || !ws.playerId) return;
    // Keep the seat (for reconnects) but drop the socket.
    if (room.sockets.get(ws.playerId) === ws) room.sockets.delete(ws.playerId);
    broadcast(room);
  });
});

function handle(ws, msg) {
  switch (msg.type) {
    case 'createTable': {
      const startingStack = clampInt(msg.startingStack, 1, 1000, 1000);
      const bigBlind = clampInt(msg.bigBlind, 2, Math.max(2, Math.floor(startingStack / 10)), 10);
      const smallBlind = clampInt(msg.smallBlind, 1, bigBlind - 1, Math.max(1, Math.floor(bigBlind / 2)));
      const room = createRoom({ startingStack, smallBlind, bigBlind });
      joinRoom(ws, room, msg.name);
      room.hostId = ws.playerId; // creator is host
      broadcast(room);
      break;
    }
    case 'joinTable': {
      const room = rooms.get((msg.code || '').toUpperCase());
      if (!room) throw new Error('No table with that code');
      joinRoom(ws, room, msg.name, msg.playerId);
      broadcast(room);
      break;
    }
    case 'startHand': {
      const room = requireRoom(ws);
      if (ws.playerId !== room.hostId) throw new Error('Only the host can deal');
      clearTimeout(room.dealTimer);
      room.table.startHand();
      afterAction(room);
      break;
    }
    case 'action': {
      const room = requireRoom(ws);
      room.table.act(ws.playerId, msg.action);
      afterAction(room);
      break;
    }
    case 'newSession': {
      const room = requireRoom(ws);
      if (ws.playerId !== room.hostId) throw new Error('Only the host can reset');
      clearTimeout(room.dealTimer);
      room.table.resetStacks();
      broadcast(room);
      break;
    }
    case 'sitOut': {
      const room = requireRoom(ws);
      const seat = room.table.seatOf(ws.playerId);
      if (seat !== -1) room.table.seats[seat].sittingOut = !!msg.value;
      broadcast(room);
      break;
    }
    case 'leave': {
      const room = requireRoom(ws);
      room.table.removePlayer(ws.playerId);
      room.sockets.delete(ws.playerId);
      if (ws.playerId === room.hostId) {
        const next = room.table.players()[0];
        room.hostId = next ? next.id : null;
      }
      ws.roomCode = null;
      broadcast(room);
      break;
    }
    default:
      throw new Error('Unknown message');
  }
}

function joinRoom(ws, room, name, existingId) {
  // Reconnect path: same playerId already seated -> just reattach the socket.
  if (existingId && room.table.seatOf(existingId) !== -1) {
    ws.playerId = existingId;
    ws.roomCode = room.code;
    room.sockets.set(existingId, ws);
    send(ws, { type: 'joined', code: room.code, playerId: existingId, seat: room.table.seatOf(existingId) });
    return;
  }
  const cleanName = (name || 'Player').toString().slice(0, 16).trim() || 'Player';
  const playerId = randomUUID();
  const seat = room.table.addPlayer({ id: playerId, name: cleanName });
  ws.playerId = playerId;
  ws.roomCode = room.code;
  room.sockets.set(playerId, ws);
  if (!room.hostId) room.hostId = playerId;
  send(ws, { type: 'joined', code: room.code, playerId, seat });
}

function requireRoom(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) throw new Error('Not in a table');
  return room;
}

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// Periodic cleanup of empty, idle tables.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const connected = [...room.sockets.values()].some((ws) => ws.readyState === ws.OPEN);
    if (!connected && now - room.lastActivity > EMPTY_TABLE_TTL_MS) {
      clearTimeout(room.turnTimer);
      clearTimeout(room.dealTimer);
      rooms.delete(code);
    }
  }
}, 60_000).unref();

server.listen(PORT, () => {
  console.log(`♠ Poker for Ganjutti running at http://localhost:${PORT}`);
});
