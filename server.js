// server.js — Chromatic Echo. HTTP static + WebSocket, authoritative host, with bots.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const G = require("./game");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const BOT_NAMES = ["Echo", "Riff", "Tempo", "Chord", "Vibe", "Beat", "Scale", "Note"];

// ---- static file server ------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  let url = req.url.split("?")[0];
  if (url === "/") url = "/index.html";
  const file = path.join(PUBLIC, path.normalize(url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---- room registry -----------------------------------------------------------
// room: { code, hostId, started, clients: Map<clientId,{ws,name,color}>,
//         bots: Map<botId,{name,color}>, game, timers, botCounter }
const rooms = new Map();

const DEFAULT_SETTINGS = { difficulty: "normal", soundPack: "piano" };

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c;
  do { c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
  while (rooms.has(c));
  return c;
}

const isBot = (id) => typeof id === "string" && id.startsWith("bot");

function takenColors(room) {
  const set = new Set();
  for (const c of room.clients.values()) if (c.color != null) set.add(c.color);
  for (const b of room.bots.values()) set.add(b.color);
  return set;
}
function firstFreeColor(room) {
  const taken = takenColors(room);
  for (let i = 0; i < G.PALETTE.length; i++) if (!taken.has(i)) return i;
  return null;
}

function roomPlayers(room) {
  const humans = [...room.clients.entries()]
    .map(([id, c]) => ({ id, name: c.name, color: c.color }));
  const bots = [...room.bots.entries()].map(([id, b]) => ({ id, name: b.name, color: b.color }));
  return [...humans, ...bots];
}

function lobbyState(room) {
  const humans = [...room.clients.entries()].map(([id, c]) => ({
    id, name: c.name, color: c.color, connected: c.ws.readyState === 1, kind: "human",
  }));
  const bots = [...room.bots.entries()].map(([id, b]) => ({
    id, name: b.name, color: b.color, connected: true, kind: "bot",
  }));
  return {
    t: "lobby", code: room.code, hostId: room.hostId, started: room.started,
    players: [...humans, ...bots], palette: G.PALETTE,
    settings: room.settings, difficulties: G.DIFFICULTY, soundPacks: G.SOUND_PACK_META,
  };
}

function send(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }
function broadcast(room, obj) { for (const c of room.clients.values()) send(c.ws, obj); }
function broadcastState(room) {
  if (!room.game) return broadcast(room, lobbyState(room));
  broadcast(room, { t: "state", state: G.publicState(room.game), palette: G.PALETTE });
}

// ---- timers ------------------------------------------------------------------
function clearTimers(room) {
  if (room.timers) for (const t of Object.values(room.timers)) clearTimeout(t);
  room.timers = {};
}

// central turn driver: bot auto-plays, human gets a timeout timer
function driveTurn(room) {
  const g = room.game;
  if (!g || g.phase !== "PLAYING" || g.over) return;
  clearTimeout(room.timers.turn);
  clearTimeout(room.timers.bot);
  if (isBot(g.currentId)) scheduleBotTurn(room);
  else scheduleTurnTimer(room);
}

function scheduleTurnTimer(room) {
  const g = room.game;
  if (!g || g.phase !== "PLAYING" || g.over) return;
  const ms = G.turnTimeMs(g);
  const turnId = g.currentId, roundSnapshot = g.round;
  room.timers.turn = setTimeout(() => {
    if (!room.game || room.game.over) return;
    if (room.game.currentId === turnId && room.game.round === roundSnapshot && room.game.phase === "PLAYING") {
      const r = G.timeoutCurrent(room.game);
      broadcast(room, { t: "event", event: { kind: "timeout", ...r } });
      afterMove(room);
    }
  }, ms + 400);
}

// ---- BOTS: turn play ---------------------------------------------------------
// Bot memory degrades as the sequence grows -> games resolve, humans can win.
// Skill scales with difficulty (see game.js botErrorChance / cfg).
function scheduleBotTurn(room) {
  room.timers.bot = setTimeout(() => botStep(room), 750);
}

function botStep(room) {
  const g = room.game;
  if (!g || g.phase !== "PLAYING" || g.over) return;
  const id = g.currentId;
  if (!isBot(id)) return;

  let colorToClick;
  if (g.replayPos < g.sequence.length) {
    const botP = G.getPlayer(g, id);
    const expected = G.expectedAt(g, botP, g.replayPos);
    if (Math.random() < G.botErrorChance(g)) {
      // bot slips: click a wrong color
      let wrong = (expected + 1 + Math.floor(Math.random() * (G.PALETTE.length - 1))) % G.PALETTE.length;
      colorToClick = wrong;
    } else colorToClick = expected;
  } else {
    // adding: bot picks a random color (colors are free-choice, not identity)
    colorToClick = Math.floor(Math.random() * G.PALETTE.length);
  }

  const r = G.applyClick(g, id, colorToClick);
  if (!r.ok) { afterMove(room); return; }
  broadcast(room, { t: "event", event: r, byId: id, color: colorToClick });

  if (["turn_complete", "eliminated", "eliminated_game_over"].includes(r.kind)) {
    afterMove(room);
  } else {
    broadcastState(room);
    // continue same bot's turn (next replay step or next add)
    room.timers.bot = setTimeout(() => botStep(room), 480);
  }
}

// ---- duel scheduling ---------------------------------------------------------
function maybeScheduleDuel(room) {
  const g = room.game;
  if (!g || g.over) return;
  const sinceDuel = Date.now() - g.lastDuelAt;
  const untilDuel = Math.max(2000, g.cfg.duelIntervalMs - sinceDuel);
  const untilHardCap = g.cfg.hardCapMs - (Date.now() - g.startedAt);
  if (untilHardCap <= untilDuel) {
    room.timers.duel = setTimeout(() => triggerDuel(room, true), Math.max(1000, untilHardCap));
  } else {
    room.timers.duel = setTimeout(() => triggerDuel(room, false), untilDuel);
  }
}

function triggerDuel(room, isFinal) {
  const g = room.game;
  if (!g || g.over || g.phase !== "PLAYING") { maybeScheduleDuel(room); return; }
  if (G.alivePlayers(g).length < 2 && !isFinal) { maybeScheduleDuel(room); return; }
  clearTimeout(room.timers.turn);
  clearTimeout(room.timers.bot);
  const r = G.startDuel(g, isFinal);
  broadcast(room, { t: "duel_start", sequence: r.sequence, isFinal, state: G.publicState(g) });
  const perColor = 650;
  const watchMs = r.sequence.length * perColor * 2 + 1200;
  const countdownMs = 3200;
  room.timers.duelGo = setTimeout(() => {
    if (!room.game || room.game.phase !== "DUEL") return;
    G.beginDuelRace(room.game);
    broadcast(room, { t: "duel_go", state: G.publicState(room.game) });
    driveDuelBots(room);
    room.timers.duelEnd = setTimeout(() => finishDuel(room), 15000);
  }, watchMs + countdownMs);
}

// bots race in the duel — variable speed & skill so it stays fun
function driveDuelBots(room) {
  const g = room.game;
  if (!g || g.phase !== "DUEL" || !g.duel) return;
  for (const [id, b] of room.bots.entries()) {
    const p = G.getPlayer(g, id);
    if (!p || !p.alive) continue;
    const seq = g.duel.sequence;
    const startDelay = g.cfg.duelStartMin + Math.random() * (g.cfg.duelStartMax - g.cfg.duelStartMin);
    const interval = 240 + Math.random() * 220;
    seq.forEach((color, i) => {
      setTimeout(() => {
        if (!room.game || room.game.phase !== "DUEL" || !room.game.duel) return;
        if (room.game.duel.failed[id] || room.game.duel.finishedOrder.includes(id)) return;
        // per-step slip chance in the heat of the duel
        let c = color;
        if (Math.random() < g.cfg.duelBotSlip) c = (color + 1) % G.PALETTE.length;
        const r = G.duelClick(room.game, id, c);
        if (r.ok) {
          broadcast(room, { t: "duel_event", event: r, byId: id });
          broadcastState(room);
          if (r.kind === "duel_win" || r.kind === "duel_final_win") {
            clearTimeout(room.timers.duelEnd);
            room.timers.duelEnd = setTimeout(() => finishDuel(room), 1500);
          }
        }
      }, startDelay + i * interval);
    });
  }
}

function finishDuel(room) {
  const g = room.game;
  if (!g || g.phase !== "DUEL") return;
  clearTimeout(room.timers.duelEnd);
  const wasFinal = g.duel?.isFinal;
  const winnerId = g.duel?.winnerId || null;
  const bonus = g.duel?.bonusAwarded || null;
  G.endDuel(g);
  broadcast(room, { t: "duel_end", winnerId, bonus, wasFinal, state: G.publicState(g) });
  if (g.over) { announceOver(room); return; }
  broadcastState(room);
  driveTurn(room);
  maybeScheduleDuel(room);
}

// ---- after any move ----------------------------------------------------------
function afterMove(room) {
  const g = room.game;
  clearTimeout(room.timers.turn);
  clearTimeout(room.timers.bot);
  broadcastState(room);
  if (g.over) { announceOver(room); return; }
  if (g.phase === "PLAYING") driveTurn(room);
}

function announceOver(room) {
  clearTimers(room);
  const g = room.game;
  broadcast(room, { t: "game_over", winnerId: g.winnerId, state: G.publicState(g) });
}

// ---- WebSocket ---------------------------------------------------------------
const wss = new WebSocketServer({ server });
let nextClientId = 1;

wss.on("connection", (ws) => {
  const clientId = "c" + (nextClientId++);
  ws.clientId = clientId;
  ws.roomCode = null;
  send(ws, { t: "hello", clientId });

  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    handle(ws, msg);
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const c = room.clients.get(ws.clientId);
    if (c) c.connected = false;
    if (!room.started) {
      room.clients.delete(ws.clientId);
      if (ws.clientId === room.hostId) room.hostId = [...room.clients.keys()][0] || null;
      if (room.clients.size === 0) { clearTimers(room); rooms.delete(room.code); return; }
    }
    broadcastState(room);
  });
});

function handle(ws, msg) {
  switch (msg.t) {
    case "create": {
      const code = makeCode();
      const room = { code, hostId: ws.clientId, started: false, clients: new Map(), bots: new Map(), game: null, timers: {}, botCounter: 0, settings: { ...DEFAULT_SETTINGS } };
      rooms.set(code, room);
      joinRoom(ws, room, msg.name);
      break;
    }
    case "join": {
      const room = rooms.get((msg.code || "").toUpperCase());
      if (!room) return send(ws, { t: "error", msg: "Room not found" });
      if (room.started) return send(ws, { t: "error", msg: "Game already started" });
      if (room.clients.size + room.bots.size >= 8) return send(ws, { t: "error", msg: "Room full (8 max)" });
      joinRoom(ws, room, msg.name);
      break;
    }
    case "pickColor": {
      const room = rooms.get(ws.roomCode);
      if (!room || room.started) return;
      if (takenColors(room).has(msg.color) && room.clients.get(ws.clientId)?.color !== msg.color)
        return send(ws, { t: "error", msg: "Color taken" });
      const c = room.clients.get(ws.clientId);
      if (c) c.color = msg.color;
      broadcastState(room);
      break;
    }
    case "addBot": {
      const room = rooms.get(ws.roomCode);
      if (!room || room.started || ws.clientId !== room.hostId) return;
      if (room.clients.size + room.bots.size >= 8) return send(ws, { t: "error", msg: "Room full (8 max)" });
      const color = firstFreeColor(room);
      if (color == null) return send(ws, { t: "error", msg: "No free colors" });
      const id = "bot" + (++room.botCounter);
      const usedNames = new Set([...room.bots.values()].map((b) => b.name.replace("🤖 ", "")));
      const name = (BOT_NAMES.find((n) => !usedNames.has(n)) || ("Bot" + room.botCounter));
      room.bots.set(id, { name: "🤖 " + name, color });
      broadcastState(room);
      break;
    }
    case "removeBot": {
      const room = rooms.get(ws.roomCode);
      if (!room || room.started || ws.clientId !== room.hostId) return;
      const lastBot = [...room.bots.keys()].pop();
      if (lastBot) room.bots.delete(lastBot);
      broadcastState(room);
      break;
    }
    case "setName": {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const c = room.clients.get(ws.clientId);
      if (c && msg.name) c.name = String(msg.name).slice(0, 16);
      broadcastState(room);
      break;
    }
    case "setSettings": {
      const room = rooms.get(ws.roomCode);
      if (!room || room.started || ws.clientId !== room.hostId) return;
      if (msg.difficulty && G.DIFFICULTY[msg.difficulty]) room.settings.difficulty = msg.difficulty;
      if (msg.soundPack && G.SOUND_PACKS.includes(msg.soundPack)) room.settings.soundPack = msg.soundPack;
      broadcastState(room);
      break;
    }
    case "start": {
      const room = rooms.get(ws.roomCode);
      if (!room || room.started || ws.clientId !== room.hostId) return;
      const players = roomPlayers(room);
      if (players.length < 2) return send(ws, { t: "error", msg: "Need at least 2 players (add a bot to play solo)" });
      room.started = true;
      room.game = G.createGame(players, room.settings);
      broadcast(room, { t: "game_start", state: G.publicState(room.game), palette: G.PALETTE });
      broadcastState(room);
      driveTurn(room);
      maybeScheduleDuel(room);
      break;
    }
    case "click": {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game) return;
      const r = G.applyClick(room.game, ws.clientId, msg.color);
      if (!r.ok) return send(ws, { t: "reject", reason: r.reason });
      broadcast(room, { t: "event", event: r, byId: ws.clientId, color: msg.color });
      if (["turn_complete", "eliminated", "eliminated_game_over"].includes(r.kind)) afterMove(room);
      else broadcastState(room);
      break;
    }
    case "duelClick": {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game) return;
      const r = G.duelClick(room.game, ws.clientId, msg.color);
      if (!r.ok) return send(ws, { t: "reject", reason: r.reason });
      broadcast(room, { t: "duel_event", event: r, byId: ws.clientId });
      broadcastState(room);
      if (r.kind === "duel_win" || r.kind === "duel_final_win") {
        clearTimeout(room.timers.duelEnd);
        room.timers.duelEnd = setTimeout(() => finishDuel(room), 1500);
      }
      break;
    }
    case "rematch": {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.clientId !== room.hostId) return;
      clearTimers(room);
      room.started = false;
      room.game = null;
      broadcastState(room);
      break;
    }
    default: break;
  }
}

function joinRoom(ws, room, name) {
  ws.roomCode = room.code;
  // auto-assign a display color (by first free slot) — purely cosmetic, for the roster
  const color = firstFreeColor(room);
  room.clients.set(ws.clientId, { ws, name: (name || "Player").slice(0, 16), color, connected: true });
  send(ws, { t: "joined", code: room.code, clientId: ws.clientId, hostId: room.hostId });
  broadcastState(room);
}

server.listen(PORT, () => console.log(`Chromatic Echo on :${PORT}`));
