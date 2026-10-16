// DrawRun multiplayer — one room per pair of players, over a WebSocket at
// /ws/drawrun. Plugs into server.js with a single handleUpgrade() call; shares
// nothing with the Exquisite Corpse game state, so a bug here can't corrupt it
// (every handler is wrapped so a bad packet can't crash the process either).
//
// Split of responsibility:
//   * RUNNER's browser simulates its own physics, bullets and collisions, and
//     reports position ~20x/s and its death.
//   * SERVER owns the terrain, obstacle list and the builder's energy. Every
//     builder action is validated here against the shared rules in
//     drawrun-world.js, then broadcast to both players.
//   * BUILDER's browser just renders what the server confirms.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const DR = require('./drawrun-world.js');
const C = DR.C;

const rooms = new Map();            // code -> room
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const COUNTDOWN_MS = 3200;
const RESULT_MS = 5000;
const ROUNDS = 2;                   // each player is runner once
const RECONNECT_GRACE_MS = 20000;
const EDIT_LOG_MAX = 4000;
const AVATAR_PREFIX = 'data:image/png;base64,';

function genCode() {
  let code;
  do { code = ''; for (let i = 0; i < 5; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; } while (rooms.has(code));
  return code;
}
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Player';
const cleanAvatar = s => (typeof s === 'string' && s.startsWith(AVATAR_PREFIX) && s.length < 30000) ? s : null;
const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

function send(ws, obj) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* gone */ } } }
function broadcast(room, obj, except) { for (const p of room.players) if (p.ws && p.ws !== except) send(p.ws, obj); }
const pub = p => ({ id: p.id, name: p.name, avatar: p.avatar, connected: !!p.ws });
const lobbyMsg = room => ({ type: 'lobby', code: room.code, host: room.hostId, phase: room.phase, players: room.players.map(pub), scores: room.scores });

function newRoom(host) {
  const room = {
    code: genCode(), hostId: host.id, players: [host], phase: 'lobby', round: 0,
    world: DR.createWorld(), edits: [], runnerId: null, builderId: null,
    rs: { px: C.START_X, py: C.BASE_Y, t: 0, speed: C.SPEED, bul: 0, at: Date.now() },
    energy: 100, energyAt: Date.now(), lastActAt: 0, results: [], scores: {}, timers: [],
    createdAt: Date.now(), lastActivity: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}
function later(room, ms, fn) { const t = setTimeout(() => { room.timers = room.timers.filter(x => x !== t); try { fn(); } catch (e) { console.error('[drawrun] timer error:', e.message); } }, ms); room.timers.push(t); }
function clearTimers(room) { room.timers.forEach(clearTimeout); room.timers = []; }
const runnerOf = room => room.players.find(p => p.id === room.runnerId);
const builderOf = room => room.players.find(p => p.id === room.builderId);

// ---- energy: server-authoritative, regen scales with how long the runner has lasted ----
function tickEnergy(room) {
  const now = Date.now(), dt = Math.max(0, (now - room.energyAt) / 1000);
  room.energy = Math.min(100, room.energy + DR.regenAt(room.rs.t) * dt);
  room.energyAt = now;
}
const sendEnergy = room => send((builderOf(room) || {}).ws, { type: 'energy', e: Math.round(room.energy * 10) / 10, t: room.rs.t });

// ---- round flow ----
function startRound(room, n) {
  clearTimers(room);
  room.round = n;
  if (n === 1) {
    const a = room.players[0], b = room.players[1], flip = crypto.randomInt(2) === 0;
    room.runnerId = (flip ? a : b).id; room.builderId = (flip ? b : a).id;
    room.results = []; room.scores = {};
  } else { [room.runnerId, room.builderId] = [room.builderId, room.runnerId]; }
  room.world.reset(); room.edits = [];
  room.rs = { px: C.START_X, py: C.BASE_Y, t: 0, speed: C.SPEED, bul: 0, at: Date.now() };
  room.energy = 100; room.energyAt = Date.now();
  room.phase = 'countdown';
  const r = runnerOf(room);
  broadcast(room, roundMsg(room));
  later(room, COUNTDOWN_MS, () => {
    if (room.phase !== 'countdown') return;
    room.phase = 'play'; room.energyAt = Date.now();
    broadcast(room, { type: 'go' });
  });
}
const roundMsg = (room, rejoin) => {
  const r = runnerOf(room);
  return { type: 'round', n: room.round, of: ROUNDS, runnerId: room.runnerId, builderId: room.builderId,
    runnerAvatar: r ? r.avatar : null, hbH: r ? r.hbH : 55, countdownMs: COUNTDOWN_MS, rejoin: !!rejoin };
};
function endRound(room, dist, t, reason) {
  if (room.phase !== 'play') return;
  room.phase = 'results';
  const r = runnerOf(room);
  const res = { round: room.round, runnerId: room.runnerId, runnerName: r ? r.name : '?', dist, t, reason };
  room.results.push(res);
  room.scores[room.runnerId] = { dist, t };
  broadcast(room, { type: 'result', ...res, last: room.round >= ROUNDS });
  later(room, RESULT_MS, () => {
    if (room.round < ROUNDS) startRound(room, room.round + 1);
    else finishMatch(room);
  });
}
function finishMatch(room) {
  room.phase = 'final';
  const rows = room.results.map(r => ({ ...r }));
  let winner = null;
  if (rows.length === 2) {
    const [a, b] = rows;
    if (a.dist !== b.dist) winner = (a.dist > b.dist ? a : b).runnerId;
    else if (a.t !== b.t) winner = (a.t > b.t ? a : b).runnerId;
  }
  broadcast(room, { type: 'final', rows, winner });
}
function backToLobby(room, note) {
  clearTimers(room); room.phase = 'lobby'; room.round = 0; room.runnerId = room.builderId = null;
  room.world.reset(); room.edits = [];
  broadcast(room, { ...lobbyMsg(room), note: note || null });
}
function logEdit(room, edit) { room.edits.push(edit); if (room.edits.length > EDIT_LOG_MAX) room.edits.splice(0, room.edits.length - EDIT_LOG_MAX); }

// ---- message handlers ----
function onMessage(ws, msg) {
  const room = ws.room, me = ws.player;

  // -- entering a room --
  if (msg.type === 'create') {
    if (ws.room) return;
    const p = makePlayer(msg, ws);
    const r = newRoom(p); ws.room = r; ws.player = p;
    send(ws, { type: 'joined', code: r.code, token: p.token, id: p.id });
    broadcast(r, lobbyMsg(r)); return;
  }
  if (msg.type === 'join') {
    if (ws.room) return;
    const r = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!r) return send(ws, { type: 'error', msg: 'No room with that code' });
    if (r.phase !== 'lobby') return send(ws, { type: 'error', msg: 'That game has already started' });
    if (r.players.length >= 2) return send(ws, { type: 'error', msg: 'Room is full' });
    const p = makePlayer(msg, ws); r.players.push(p); ws.room = r; ws.player = p;
    send(ws, { type: 'joined', code: r.code, token: p.token, id: p.id });
    broadcast(r, lobbyMsg(r)); return;
  }
  if (msg.type === 'rejoin') {
    if (ws.room) return;
    const r = rooms.get(String(msg.code || '').toUpperCase());
    const p = r && r.players.find(x => x.token === msg.token);
    if (!p) return send(ws, { type: 'error', msg: 'Session expired', fatal: true });
    if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch (e) { /* */ } }
    p.ws = ws; p.dcAt = 0; ws.room = r; ws.player = p;
    send(ws, { type: 'joined', code: r.code, token: p.token, id: p.id, rejoin: true });
    send(ws, lobbyMsg(r));
    if (r.phase === 'countdown' || r.phase === 'play') {
      send(ws, roundMsg(r, true));
      for (const e of r.edits) send(ws, e);
      if (r.phase === 'play') send(ws, { type: 'go', rejoin: true });
    }
    return;
  }
  if (!room || !me) return;
  room.lastActivity = Date.now();

  switch (msg.type) {
    case 'avatar': {
      const a = cleanAvatar(msg.avatar); if (a) me.avatar = a;
      me.hbH = num(msg.hbH, 16, 60, me.hbH);
      if (room.phase === 'lobby') broadcast(room, lobbyMsg(room));
      return;
    }
    case 'start': {
      if (room.phase !== 'lobby' || me.id !== room.hostId || room.players.length < 2) return;
      if (room.players.some(p => !p.ws)) return send(ws, { type: 'error', msg: 'Waiting for your opponent to reconnect' });
      startRound(room, 1); return;
    }
    case 'rematch': {
      if (room.phase !== 'final' || me.id !== room.hostId) return;
      backToLobby(room); return;
    }
    case 'leave': { dropPlayer(ws, true); return; }

    // -- runner reports --
    case 'state': {
      if (room.phase !== 'play' || me.id !== room.runnerId) return;
      const t = num(msg.t, 0, 36000, room.rs.t);
      const px = num(msg.px, 0, 1e9, room.rs.px);
      // Plausibility: can't have travelled further than max speed allows (+slack).
      if (px - C.START_X > C.MAXSPEED * t * 1.3 + 400) return;
      room.rs = { px, py: num(msg.py, -200, 600, room.rs.py), t, speed: DR.speedAt(t), bul: Math.min(C.MAX_BULLETS, Array.isArray(msg.bul) ? msg.bul.length : 0), at: Date.now() };
      room.world.ensureAround(DR.camXFor(px));
      const bul = (Array.isArray(msg.bul) ? msg.bul : []).slice(0, C.MAX_BULLETS).map(b => [num(b[0], -1e9, 1e9, 0), num(b[1], 0, 400, 0)]);
      send((builderOf(room) || {}).ws, { type: 'state', px, py: room.rs.py, t, crouch: msg.crouch ? 1 : 0, air: msg.air ? 1 : 0, bul });
      return;
    }
    case 'dead': {
      if (room.phase !== 'play' || me.id !== room.runnerId) return;
      const t = num(msg.t, 0, 36000, room.rs.t);
      const dist = Math.round(num(msg.dist, 0, C.MAXSPEED * t * 1.3 + 400, 0));
      endRound(room, dist, Math.round(t * 10) / 10, String(msg.reason || 'Died').slice(0, 40));
      return;
    }

    // -- builder actions (allowed during countdown too, so pre-building works) --
    case 'sculpt': case 'gap': case 'place': {
      if ((room.phase !== 'play' && room.phase !== 'countdown') || me.id !== room.builderId) return;
      const now = Date.now();
      tickEnergy(room);
      const lock = DR.lockFor(room.rs.px, room.rs.speed);
      const w = room.world;
      if (msg.type === 'sculpt') {
        const res = w.sculpt(Number(msg.ax), Number(msg.sigma), Number(msg.dy), lock, room.energy);
        if (!res) return;
        room.energy -= res.cost;
        const e = { type: 'h', a: res.a, vals: res.vals, x: Number(msg.ax) };
        logEdit(room, e); broadcast(room, e); sendEnergy(room); return;
      }
      if (msg.type === 'gap') {
        const res = w.cutGap(Number(msg.x0), Number(msg.x1), lock, room.energy);
        if (res.err) return send(ws, { type: 'deny', reason: res.err });
        room.energy -= res.cost;
        const e = { type: 'gap', i0: res.i0, i1: res.i1, x: res.i0 * C.CELL };
        logEdit(room, e); broadcast(room, e); sendEnergy(room); return;
      }
      // place
      const cd = msg.kind === 'bullet' ? 300 : 250;
      if (now - room.lastActAt < cd) return;
      const res = w.place(String(msg.kind), Number(msg.x), Number(msg.y), lock, room.energy,
        { hbH: (runnerOf(room) || {}).hbH, bullets: room.rs.bul });
      if (res.err) return send(ws, { type: 'deny', reason: res.err });
      room.lastActAt = now; room.energy -= res.cost;
      if (res.obs) { w.addObs(res.obs); const e = { type: 'obs', o: res.obs, x: res.obs.x }; logEdit(room, e); broadcast(room, e); }
      else broadcast(room, { type: 'bullet', x: res.bullet.x, y: res.bullet.y });
      sendEnergy(room); return;
    }
  }
}

function makePlayer(msg, ws) {
  return { id: crypto.randomUUID(), token: crypto.randomBytes(16).toString('hex'), name: cleanName(msg.name),
    avatar: cleanAvatar(msg.avatar), hbH: num(msg.hbH, 16, 60, 55), ws, dcAt: 0 };
}

function dropPlayer(ws, explicit) {
  const room = ws.room, p = ws.player;
  if (!room || !p) return;
  ws.room = ws.player = null;
  if (explicit || room.phase === 'lobby') {
    // Leaving from the lobby (or on purpose) removes the player outright.
    room.players = room.players.filter(x => x !== p);
    if (!room.players.length) { clearTimers(room); rooms.delete(room.code); return; }
    if (room.hostId === p.id) room.hostId = room.players[0].id;
    if (room.phase !== 'lobby') backToLobby(room, p.name + ' left the game');
    else broadcast(room, lobbyMsg(room));
    return;
  }
  // Mid-game: keep the seat for a grace period so a dropped connection can rejoin.
  p.ws = null; p.dcAt = Date.now();
  broadcast(room, lobbyMsg(room));
}

wss.on('connection', ws => {
  ws.room = null; ws.player = null;
  let bucket = 200, lastRefill = Date.now();            // ~200 msgs/s burst, refills 200/s
  ws.on('message', raw => {
    try {
      const now = Date.now();
      bucket = Math.min(200, bucket + (now - lastRefill) * 0.2); lastRefill = now;
      if (--bucket < 0) return;                          // flood: drop
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      onMessage(ws, msg);
    } catch (e) { console.error('[drawrun] handler error:', e.message); }
  });
  ws.on('close', () => { try { dropPlayer(ws, false); } catch (e) { console.error('[drawrun] close error:', e.message); } });
  ws.on('error', () => { /* socket-level noise */ });
});

// Housekeeping: energy pings, disconnect grace, stale rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    try {
      if (room.phase === 'play' || room.phase === 'countdown') { tickEnergy(room); sendEnergy(room); }
      const gone = room.players.find(p => !p.ws && p.dcAt && now - p.dcAt > RECONNECT_GRACE_MS);
      if (gone && room.phase !== 'lobby') {
        room.players = room.players.filter(p => p.ws);
        if (!room.players.length) { clearTimers(room); rooms.delete(code); continue; }
        room.hostId = room.players[0].id;
        backToLobby(room, gone.name + ' disconnected');
      }
      if (!room.players.some(p => p.ws) && now - room.lastActivity > 2 * 60 * 1000) { clearTimers(room); rooms.delete(code); }
      else if (now - room.lastActivity > 60 * 60 * 1000) { clearTimers(room); rooms.delete(code); }
    } catch (e) { console.error('[drawrun] sweep error:', e.message); }
  }
}, 300);

// Returns true when it took the request, so server.js can skip its own handling.
function handleUpgrade(req, socket, head, url) {
  if (url.pathname !== '/ws/drawrun') return false;
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  return true;
}

module.exports = { handleUpgrade, _rooms: rooms };
