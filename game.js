// game.js — Chromatic Echo pure engine. NO DOM, NO network. Runs in Node + browser.
// A musical Simon-says elimination game with growing color/sound sequences,
// difficulty presets, timed bonus duels, and 8 spicy bonuses.

// 8-color palette, each mapped to a piano note (frequency in Hz, C major-ish scale).
const PALETTE = [
  { id: 0, name: "Ruby",    hex: "#e6394a", note: "C4", freq: 261.63 },
  { id: 1, name: "Amber",   hex: "#f5921b", note: "D4", freq: 293.66 },
  { id: 2, name: "Gold",    hex: "#f5d20c", note: "E4", freq: 329.63 },
  { id: 3, name: "Jade",    hex: "#27c07a", note: "F4", freq: 349.23 },
  { id: 4, name: "Teal",    hex: "#1fb6c9", note: "G4", freq: 392.00 },
  { id: 5, name: "Azure",   hex: "#3a7bf5", note: "A4", freq: 440.00 },
  { id: 6, name: "Violet",  hex: "#8b5cf6", note: "B4", freq: 493.88 },
  { id: 7, name: "Magenta", hex: "#e0399e", note: "C5", freq: 523.25 },
];

// Difficulty presets — control turn timers AND bot skill.
const DIFFICULTY = {
  easy:   { label: "Easy",   baseTurnMs: 30000, perColorMs: 1100, botErrBase: 0.05,  botErrPer: 0.020, duelBotSlip: 0.24, duelStartMin: 900,  duelStartMax: 2600 },
  normal: { label: "Normal", baseTurnMs: 22000, perColorMs: 900,  botErrBase: 0.02,  botErrPer: 0.011, duelBotSlip: 0.14, duelStartMin: 500,  duelStartMax: 2000 },
  hard:   { label: "Hard",   baseTurnMs: 15000, perColorMs: 650,  botErrBase: 0.008, botErrPer: 0.006, duelBotSlip: 0.07, duelStartMin: 300,  duelStartMax: 1400 },
};

const SOUND_PACKS = ["piano", "guitar", "synth", "retro"];
const SOUND_PACK_META = {
  piano:  { label: "🎹 Piano" },
  guitar: { label: "🎸 Guitar" },
  synth:  { label: "🎛️ Synth" },
  retro:  { label: "👾 8-bit" },
};

const BONUS_TYPES = ["EXTRA_LIFE", "DOUBLE_PLAY", "SKIP_NEXT", "FREEZE", "STEAL_LIFE", "REVERSE", "MIRROR", "SLOWMO"];
const BONUS_META = {
  EXTRA_LIFE:  { label: "Extra Life",  icon: "❤️", desc: "Survive one wrong note." },
  DOUBLE_PLAY: { label: "Double Play", icon: "⏩", desc: "Add TWO colors on your next turn." },
  SKIP_NEXT:   { label: "Skip Next",   icon: "⤵️", desc: "The next player is skipped." },
  FREEZE:      { label: "Freeze",      icon: "❄️", desc: "Extra time on your next turn." },
  STEAL_LIFE:  { label: "Steal Life",  icon: "🩸", desc: "Take a life from the leader (or gain one)." },
  REVERSE:     { label: "Reverse",     icon: "🔄", desc: "Flip the turn order direction!" },
  MIRROR:      { label: "Mirror",      icon: "🪞", desc: "Next player must replay it BACKWARDS." },
  SLOWMO:      { label: "Slow-Mo",     icon: "🐢", desc: "Get a slow replay peek on your next turn." },
};

// ---- game construction -------------------------------------------------------
// players: [{ id, name, color }]
function createGame(players, opts = {}) {
  const diffKey = DIFFICULTY[opts.difficulty] ? opts.difficulty : "normal";
  const d = DIFFICULTY[diffKey];
  const cfg = {
    difficulty: diffKey,
    soundPack: SOUND_PACKS.includes(opts.soundPack) ? opts.soundPack : "piano",
    baseTurnMs: d.baseTurnMs,
    perColorMs: d.perColorMs,
    maxTurnMs: 60000,
    botErrBase: d.botErrBase,
    botErrPer: d.botErrPer,
    duelBotSlip: d.duelBotSlip,
    duelStartMin: d.duelStartMin,
    duelStartMax: d.duelStartMax,
    duelIntervalMs: opts.duelIntervalMs ?? 60000,
    duelLength: opts.duelLength ?? 7,
    hardCapMs: opts.hardCapMs ?? 600000,
  };
  return {
    phase: "PLAYING",
    players: players.map((p) => ({
      id: p.id, name: p.name, color: p.color,
      alive: true, extraLives: 0,
      doublePending: false, freezePending: false,
      mirrorTurn: false, slowmoPending: false,
      bonuses: [], addsThisTurn: 0,
      streak: 0, bestStreak: 0, turnsDone: 0,
    })),
    sequence: [],
    turnOrder: players.map((p) => p.id),
    direction: 1,               // 1 = forward, -1 = reversed (REVERSE bonus)
    currentId: players[0].id,
    replayPos: 0,
    toAdd: 1,
    round: 0,
    over: false,
    winnerId: null,
    startedAt: Date.now(),
    lastDuelAt: Date.now(),
    cfg,
    log: [],
    duel: null,
    _pendingSkip: 0,
    _mirrorNext: false,
    lastBonusEvent: null,       // for client toasts on state sync
  };
}

function alivePlayers(g) { return g.players.filter((p) => p.alive); }
function getPlayer(g, id) { return g.players.find((p) => p.id === id); }

function turnTimeMs(g) {
  const p = getPlayer(g, g.currentId);
  let ms = Math.min(g.cfg.baseTurnMs + g.sequence.length * g.cfg.perColorMs, g.cfg.maxTurnMs);
  if (p && p.freezePending) ms = Math.min(ms + 8000, g.cfg.maxTurnMs + 8000);
  return ms;
}

function orderIndex(g, id) { return g.turnOrder.indexOf(id); }

// next alive player honoring direction + skip count
function nextAliveId(g, id, skip = 0) {
  const order = g.turnOrder;
  let idx = orderIndex(g, id);
  let steps = 0, skipsLeft = skip;
  const dir = g.direction >= 0 ? 1 : -1;
  while (steps < order.length * 4) {
    idx = (idx + dir + order.length) % order.length;
    const cand = getPlayer(g, order[idx]);
    steps++;
    if (cand && cand.alive) {
      if (skipsLeft > 0) { skipsLeft--; continue; }
      return cand.id;
    }
  }
  return null;
}

// the color the current player must click at position `pos` (honors MIRROR)
function expectedAt(g, p, pos) {
  if (p && p.mirrorTurn) return g.sequence[g.sequence.length - 1 - pos];
  return g.sequence[pos];
}

// ---- the core turn logic -----------------------------------------------------
function applyClick(g, playerId, colorId) {
  if (g.phase !== "PLAYING") return { ok: false, reason: "not_playing" };
  if (g.over) return { ok: false, reason: "over" };
  if (playerId !== g.currentId) return { ok: false, reason: "not_your_turn" };
  const p = getPlayer(g, playerId);
  if (!p || !p.alive) return { ok: false, reason: "dead" };

  // sub-phase 1: replaying existing sequence
  if (g.replayPos < g.sequence.length) {
    const expected = expectedAt(g, p, g.replayPos);
    if (colorId === expected) {
      g.replayPos++;
      return {
        ok: true, kind: "replay_correct", colorId,
        pos: g.replayPos, total: g.sequence.length,
        done: g.replayPos >= g.sequence.length,
      };
    }
    return eliminateOrSave(g, p, colorId, "replay");
  }

  // sub-phase 2: adding new color(s)
  g.sequence.push(colorId);
  p.addsThisTurn++;
  if (p.addsThisTurn >= g.toAdd) return endTurn(g, p, colorId);
  return { ok: true, kind: "add_more", colorId, added: p.addsThisTurn, need: g.toAdd };
}

function eliminateOrSave(g, p, colorId, where) {
  if (p.extraLives > 0) {
    p.extraLives--;
    g.log.push({ t: "SAVED", id: p.id, name: p.name });
    return {
      ok: true, kind: "saved_by_life", colorId, where,
      extraLivesLeft: p.extraLives, pos: g.replayPos, total: g.sequence.length,
    };
  }
  p.alive = false;
  p.streak = 0;
  g.log.push({ t: "ELIMINATED", id: p.id, name: p.name, where });
  const survivors = alivePlayers(g);
  if (survivors.length <= 1) {
    g.over = true; g.phase = "OVER";
    g.winnerId = survivors.length === 1 ? survivors[0].id : null;
    return { ok: true, kind: "eliminated_game_over", eliminatedId: p.id, winnerId: g.winnerId };
  }
  startTurnFor(g, nextAliveId(g, p.id, 0));
  return { ok: true, kind: "eliminated", eliminatedId: p.id, nextId: g.currentId };
}

function endTurn(g, p, lastColorId) {
  p.addsThisTurn = 0;
  p.turnsDone++;
  p.streak++;
  if (p.streak > p.bestStreak) p.bestStreak = p.streak;
  if (p.freezePending) p.freezePending = false;
  p.mirrorTurn = false;
  if (p.slowmoPending) p.slowmoPending = false;
  let skip = 0;
  if (g._pendingSkip) { skip = g._pendingSkip; g._pendingSkip = 0; }
  startTurnFor(g, nextAliveId(g, p.id, skip));
  return { ok: true, kind: "turn_complete", nextId: g.currentId, seqLen: g.sequence.length, streak: p.streak };
}

function startTurnFor(g, id) {
  g.currentId = id;
  g.replayPos = 0;
  g.round++;
  const p = getPlayer(g, id);
  if (!p) return;
  g.toAdd = p.doublePending ? 2 : 1;
  if (p.doublePending) p.doublePending = false;
  // apply queued mirror to this incoming player
  if (g._mirrorNext) { p.mirrorTurn = true; g._mirrorNext = false; }
}

// ---- turn timeout ------------------------------------------------------------
function timeoutCurrent(g) {
  if (g.phase !== "PLAYING" || g.over) return { ok: false };
  const p = getPlayer(g, g.currentId);
  if (!p) return { ok: false };
  return eliminateOrSave(g, p, -1, "timeout");
}

// ---- BONUS DUEL --------------------------------------------------------------
function startDuel(g, isFinal = false) {
  const seq = [];
  for (let i = 0; i < g.cfg.duelLength; i++) seq.push(Math.floor(Math.random() * PALETTE.length));
  g.phase = "DUEL";
  g.duel = {
    isFinal, sequence: seq,
    progress: {}, finishedOrder: [], failed: {},
    startedRace: false, winnerId: null, bonusAwarded: null,
  };
  for (const p of alivePlayers(g)) g.duel.progress[p.id] = 0;
  return { ok: true, kind: "duel_start", sequence: seq, isFinal };
}

function beginDuelRace(g) {
  if (g.phase !== "DUEL" || !g.duel) return { ok: false };
  g.duel.startedRace = true;
  g.duel.raceStartedAt = Date.now();
  return { ok: true, kind: "duel_go" };
}

function duelClick(g, playerId, colorId) {
  if (g.phase !== "DUEL" || !g.duel || !g.duel.startedRace) return { ok: false, reason: "not_racing" };
  const d = g.duel;
  const p = getPlayer(g, playerId);
  if (!p || !p.alive) return { ok: false, reason: "dead" };
  if (d.failed[playerId]) return { ok: false, reason: "already_failed" };
  if (d.finishedOrder.includes(playerId)) return { ok: false, reason: "already_done" };

  const pos = d.progress[playerId] ?? 0;
  if (colorId !== d.sequence[pos]) {
    d.failed[playerId] = true;
    return { ok: true, kind: "duel_wrong", playerId };
  }
  d.progress[playerId] = pos + 1;
  if (d.progress[playerId] >= d.sequence.length) {
    d.finishedOrder.push(playerId);
    if (!d.winnerId) {
      d.winnerId = playerId;
      const bonus = awardBonus(g, playerId, d.isFinal);
      d.bonusAwarded = bonus;
      if (d.isFinal) { g.over = true; return { ok: true, kind: "duel_final_win", winnerId: playerId }; }
      return { ok: true, kind: "duel_win", playerId, bonus, pos: d.progress[playerId], total: d.sequence.length };
    }
    return { ok: true, kind: "duel_finished_late", playerId };
  }
  return { ok: true, kind: "duel_correct", playerId, pos: d.progress[playerId], total: d.sequence.length };
}

function awardBonus(g, playerId, isFinal) {
  if (isFinal) return null;
  const p = getPlayer(g, playerId);
  const type = BONUS_TYPES[Math.floor(Math.random() * BONUS_TYPES.length)];
  p.bonuses.push(type);
  switch (type) {
    case "EXTRA_LIFE": p.extraLives++; break;
    case "DOUBLE_PLAY": p.doublePending = true; break;
    case "SKIP_NEXT": g._pendingSkip = (g._pendingSkip || 0) + 1; break;
    case "FREEZE": p.freezePending = true; break;
    case "STEAL_LIFE": {
      p.extraLives++;
      // steal from the alive opponent with the most extra lives
      const victim = alivePlayers(g)
        .filter((x) => x.id !== playerId && x.extraLives > 0)
        .sort((a, b) => b.extraLives - a.extraLives)[0];
      if (victim) victim.extraLives--;
      break;
    }
    case "REVERSE": g.direction = -g.direction; break;
    case "MIRROR": g._mirrorNext = true; break;
    case "SLOWMO": p.slowmoPending = true; break;
  }
  g.log.push({ t: "BONUS", id: playerId, name: p.name, bonus: type });
  g.lastBonusEvent = { playerId, type };
  return { type, ...BONUS_META[type] };
}

function endDuel(g) {
  if (g.over) { g.phase = "OVER"; g.winnerId = g.duel?.winnerId ?? g.winnerId; g.duel = null; return { ok: true, kind: "game_over_after_final" }; }
  g.phase = "PLAYING";
  g.lastDuelAt = Date.now();
  g.duel = null;
  g.replayPos = 0;
  const p = getPlayer(g, g.currentId);
  if (!p || !p.alive) startTurnFor(g, nextAliveId(g, g.currentId, 0));
  return { ok: true, kind: "duel_end", currentId: g.currentId };
}

// ---- public snapshot ---------------------------------------------------------
function publicState(g) {
  return {
    phase: g.phase,
    difficulty: g.cfg.difficulty,
    soundPack: g.cfg.soundPack,
    direction: g.direction,
    players: g.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, alive: p.alive,
      extraLives: p.extraLives, bonuses: p.bonuses,
      doublePending: p.doublePending, freezePending: p.freezePending,
      mirrorTurn: p.mirrorTurn, slowmoPending: p.slowmoPending,
      streak: p.streak, bestStreak: p.bestStreak,
    })),
    sequence: g.sequence,
    currentId: g.currentId,
    replayPos: g.replayPos,
    toAdd: g.toAdd,
    round: g.round,
    over: g.over,
    winnerId: g.winnerId,
    startedAt: g.startedAt,
    elapsedMs: Date.now() - g.startedAt,
    turnTimeMs: g.phase === "PLAYING" ? turnTimeMs(g) : null,
    mirrorActive: !!(getPlayer(g, g.currentId) && getPlayer(g, g.currentId).mirrorTurn),
    slowmoActive: !!(getPlayer(g, g.currentId) && getPlayer(g, g.currentId).slowmoPending),
    lastBonusEvent: g.lastBonusEvent,
    duel: g.duel ? {
      isFinal: g.duel.isFinal, sequence: g.duel.sequence,
      startedRace: g.duel.startedRace, finishedOrder: g.duel.finishedOrder,
      winnerId: g.duel.winnerId, bonusAwarded: g.duel.bonusAwarded, failed: g.duel.failed,
    } : null,
  };
}

// bot error chance driven by difficulty cfg
function botErrorChance(g) {
  return Math.min(0.6, g.cfg.botErrBase + g.cfg.botErrPer * g.sequence.length);
}

module.exports = {
  PALETTE, BONUS_TYPES, BONUS_META, DIFFICULTY, SOUND_PACKS, SOUND_PACK_META,
  createGame, applyClick, timeoutCurrent,
  startDuel, beginDuelRace, duelClick, endDuel,
  publicState, turnTimeMs, alivePlayers, getPlayer, nextAliveId, expectedAt, botErrorChance,
};
