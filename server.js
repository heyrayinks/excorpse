// Load environment variables first
require('./env.js');

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth.js');
const payments = require('./payments.js');
const account = require('./account.js');
const data = require('./data.js');

const PORT = process.env.PORT || 3000;

// ===== In-memory game store =====
const games = new Map();

// Clean up games older than 24 hours
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [code, game] of games) {
    if (game.createdAt < cutoff) games.delete(code);
  }
}, 60 * 60 * 1000);

function generateCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(chars.length)];
    }
  } while (games.has(code));
  return code;
}

const SECTIONS = ['head', 'torso', 'legs']; // section drawn in round 1, 2, 3 (always 3 rounds)

// Rotation: in round r, player p works on sheet ((p - 1 + r - 1) % N), where N
// is the number of players (2 or 3). With 2 players there are only 2 sheets,
// so they simply alternate/swap sheets each round instead of a 3-way rotation.
function sheetForPlayer(playerOrder, round, maxPlayers) {
  return (playerOrder - 1 + round - 1) % maxPlayers;
}

function publicState(game, playerId) {
  const player = game.players.find(p => p.id === playerId) || null;
  const round = game.round; // 1..3, null when waiting/completed
  const section = round ? SECTIONS[round - 1] : null;

  const state = {
    code: game.code,
    status: game.status, // waiting | active | completed
    mode: game.mode,
    maxPlayers: game.maxPlayers,
    timePerTurn: game.timePerTurn,
    round,
    section, // what everyone is drawing this round
    roundStartedAt: game.roundStartedAt || null,
    players: game.players.map(p => ({
      name: p.name,
      order: p.order,
      submitted: round ? !!p.submissions[round] : false,
    })),
    you: null,
  };

  if (player) {
    state.you = {
      name: player.name,
      order: player.order,
      submitted: round ? !!player.submissions[round] : false,
    };

    // Edge hint: the bottom strip of the previous section on the sheet
    // this player is working on this round. Only that — no spoilers.
    if (game.status === 'active' && round && round > 1 && !player.submissions[round]) {
      const sheetIdx = sheetForPlayer(player.order, round, game.maxPlayers);
      const prevSection = game.sheets[sheetIdx][SECTIONS[round - 2]];
      if (prevSection && prevSection.edgeStrip) {
        state.edgeHint = prevSection.edgeStrip;
      }
    }
  }

  // Full reveal only when completed: one sheet per player, each with head/torso/legs
  if (game.status === 'completed') {
    state.sheets = game.sheets.map((sheet, i) => ({
      sheet: i + 1,
      sections: SECTIONS.map(sec => ({
        section: sec,
        image: sheet[sec] ? sheet[sec].image : null,
        artist: sheet[sec] ? sheet[sec].artist : null,
        inspiration: sheet[sec] ? sheet[sec].inspiration : null,
      })),
    }));
  }

  return state;
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes, cb) {
  let data = '';
  let overflow = false;
  req.on('data', chunk => {
    data += chunk;
    if (data.length > maxBytes) {
      overflow = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (overflow) return cb(new Error('Payload too large'));
    try {
      cb(null, data ? JSON.parse(data) : {});
    } catch (e) {
      cb(new Error('Invalid JSON'));
    }
  });
  req.on('error', () => cb(new Error('Request error')));
}

// ===== API =====
function handleApi(req, res, url) {
  // ===== STRIPE/PAYMENTS =====
  if (url.pathname === '/api/stripe/checkout' && req.method === 'POST') {
    return readBody(req, 10_000, async (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      try {
        const session = await payments.createCheckoutSession(body.email, body.username, body.password);
        json(res, 201, { url: session.url });
      } catch (e) {
        const status = e.status || 500;
        json(res, status, { error: e.error || e.message });
      }
    });
  }

  // POST /api/webhooks/stripe - raw body required for signature verification
  if (url.pathname === '/api/webhooks/stripe' && req.method === 'POST') {
    let rawBody = '';
    req.on('data', chunk => {
      rawBody += chunk;
      if (rawBody.length > 1_000_000) req.destroy(); // prevent DoS
    });
    req.on('end', async () => {
      try {
        const sig = req.headers['stripe-signature'];
        await payments.handleWebhook(rawBody, sig);
        json(res, 200, { received: true });
      } catch (e) {
        const status = e.status || 500;
        json(res, status, { error: e.error || e.message });
      }
    });
    return;
  }

  // GET /api/auth/checkout-status - poll after redirect; ready once the webhook has created the user
  if (url.pathname.startsWith('/api/auth/checkout-status') && req.method === 'GET') {
    const sessionId = url.searchParams.get('session_id');
    if (!sessionId) {
      return json(res, 400, { error: 'session_id required' });
    }

    const user = data.getUserByCheckoutSessionId(sessionId);
    if (!user) {
      return json(res, 200, { ready: false });
    }

    const token = auth.signToken(user.id);
    return json(res, 200, { ready: true, token, user: account.serializeUser(user) });
  }

  // ===== AUTH =====
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    return readBody(req, 10_000, async (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      try {
        const result = await auth.handleLogin(body);
        json(res, 200, result);
      } catch (e) {
        const status = e.status || 500;
        json(res, status, { error: e.error || e.message });
      }
    });
  }

  // ===== ACCOUNT ENDPOINTS (require auth) =====
  if (url.pathname === '/api/account/me' && req.method === 'GET') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      const user = account.getMe(userId);
      return json(res, 200, { user });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  if (url.pathname === '/api/account/username' && req.method === 'PUT') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return readBody(req, 10_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const user = await account.updateUsername(userId, body.username);
          json(res, 200, { user });
        } catch (e) {
          const status = e.status || 500;
          json(res, status, { error: e.error || e.message });
        }
      });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  if (url.pathname === '/api/account/avatar' && req.method === 'PUT') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return readBody(req, 1_000_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const user = await account.updateAvatar(userId, body.image);
          json(res, 200, { user });
        } catch (e) {
          const status = e.status || 500;
          json(res, status, { error: e.error || e.message });
        }
      });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  if (url.pathname === '/api/account/favorites' && req.method === 'POST') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return readBody(req, 8_000_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const user = await account.addFavorite(
            userId,
            body.image,
            body.gameCode,
            body.artists,
            body.inspirations
          );
          json(res, 201, { user });
        } catch (e) {
          const status = e.status || 500;
          json(res, status, { error: e.error || e.message });
        }
      });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  const favMatch = url.pathname.match(/^\/api\/account\/favorites\/([a-f0-9-]+)$/);
  if (favMatch && req.method === 'DELETE') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      account.removeFavorite(userId, favMatch[1]).then(user => {
        json(res, 200, { user });
      }).catch(e => {
        const status = e.status || 500;
        json(res, status, { error: e.error || e.message });
      });
      return;
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  // ===== GAMES API (existing, unchanged) =====
  // POST /api/games -> create
  if (req.method === 'POST' && url.pathname === '/api/games') {
    return readBody(req, 10_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      const mode = body.mode === 'timed' ? 'timed' : 'async';
      const timePerTurn = mode === 'timed' ? Math.min(10, Math.max(1, Number(body.timePerTurn) || 3)) : null;
      const maxPlayers = Math.min(10, Math.max(2, Number(body.maxPlayers) || 3)); // 2-10 players
      const code = generateCode();
      games.set(code, {
        code,
        status: 'waiting',
        mode,
        timePerTurn,
        maxPlayers,
        players: [],
        sheets: Array.from({ length: maxPlayers }, () => ({})), // sheet -> { head: {image, edgeStrip, artist, inspiration}, torso: ..., legs: ... }
        round: null,
        roundStartedAt: null,
        createdAt: Date.now(),
      });
      json(res, 201, { code });
    });
  }

  const match = url.pathname.match(/^\/api\/games\/([A-Z0-9]{6})(?:\/(join|start|submit))?$/i);
  if (!match) return json(res, 404, { error: 'Not found' });

  const code = match[1].toUpperCase();
  const action = match[2] || null;
  const game = games.get(code);
  if (!game) return json(res, 404, { error: 'Game not found' });

  // GET /api/games/:code?playerId= -> poll state
  if (req.method === 'GET' && !action) {
    const playerId = url.searchParams.get('playerId') || '';
    return json(res, 200, publicState(game, playerId));
  }

  // POST /api/games/:code/join { name }
  if (req.method === 'POST' && action === 'join') {
    return readBody(req, 10_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      if (game.status !== 'waiting') return json(res, 409, { error: 'Game already started' });
      if (game.players.length >= game.maxPlayers) return json(res, 409, { error: 'Game is full' });
      const name = String(body.name || '').trim().slice(0, 30);
      if (!name) return json(res, 400, { error: 'Name is required' });

      const player = {
        id: crypto.randomUUID(),
        name,
        order: game.players.length + 1,
        submissions: {}, // round -> true
      };
      game.players.push(player);
      json(res, 200, { playerId: player.id, ...publicState(game, player.id) });
    });
  }

  // POST /api/games/:code/start { playerId } (creator only)
  if (req.method === 'POST' && action === 'start') {
    return readBody(req, 10_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      const player = game.players.find(p => p.id === body.playerId);
      if (!player || player.order !== 1) return json(res, 403, { error: 'Only the game creator can start' });
      if (game.players.length < game.maxPlayers) return json(res, 409, { error: `Need ${game.maxPlayers} players to start` });
      if (game.status !== 'waiting') return json(res, 409, { error: 'Game already started' });
      game.status = 'active';
      game.round = 1;
      game.roundStartedAt = Date.now();
      json(res, 200, publicState(game, body.playerId));
    });
  }

  // POST /api/games/:code/submit { playerId, image, edgeStrip }
  if (req.method === 'POST' && action === 'submit') {
    return readBody(req, 8_000_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      if (game.status !== 'active') return json(res, 409, { error: 'Game is not active' });
      const player = game.players.find(p => p.id === body.playerId);
      if (!player) return json(res, 403, { error: 'Unknown player' });
      if (player.submissions[game.round]) return json(res, 409, { error: 'Already submitted this round' });

      const image = String(body.image || '');
      const edgeStrip = String(body.edgeStrip || '');
      const inspiration = String(body.inspWord || '').trim().slice(0, 40);
      if (!image.startsWith('data:image/png;base64,')) {
        return json(res, 400, { error: 'Invalid image' });
      }

      const sheetIdx = sheetForPlayer(player.order, game.round, game.maxPlayers);
      const section = SECTIONS[game.round - 1];
      game.sheets[sheetIdx][section] = {
        image,
        edgeStrip: edgeStrip.startsWith('data:image/png;base64,') ? edgeStrip : null,
        artist: player.name,
        inspiration: inspiration || null,
      };
      player.submissions[game.round] = true;

      // Advance round when everyone has submitted
      const allSubmitted = game.players.every(p => p.submissions[game.round]);
      if (allSubmitted) {
        if (game.round >= 3) {
          game.status = 'completed';
          game.round = null;
          game.completedAt = Date.now();
        } else {
          game.round += 1;
          game.roundStartedAt = Date.now();
        }
      }
      json(res, 200, publicState(game, body.playerId));
    });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

// ===== Static files =====
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  let filePath = path.normalize(path.join(__dirname, url.pathname));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (url.pathname === '/' || url.pathname.startsWith('/game')) {
    filePath = path.join(__dirname, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          return res.end('<h1>404 - Not Found</h1>');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Exquisite Corpse server running at http://localhost:${PORT}/`);
});
