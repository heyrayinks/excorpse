// Load environment variables first
require('./env.js');

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const auth = require('./auth.js');
const payments = require('./payments.js');
const account = require('./account.js');
const friends = require('./friends.js');
const data = require('./data.js');

const PORT = process.env.PORT || 3000;

// Background photos live in /photos and are named by the contributor —
// either an Unsplash export ("first-last-<photoId>-unsplash.jpg") or a
// simpler "first-last-filename.jpg" for future direct contributions.
// Parsing the name from the filename means dropping a new photo in is
// the entire workflow — no code change needed to add it to the rotation.
const NAME_PARTICLES = new Set(['de', 'van', 'von', 'der', 'la', 'le', 'di', 'du', 'da']);

function titleCaseName(tokens) {
  return tokens
    .map(w => NAME_PARTICLES.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function creditFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const parts = base.split('-').filter(Boolean);
  if (parts.length === 0) return 'Unknown';

  if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === 'unsplash') {
    // "...-<photoId>-unsplash" — drop the id and the "unsplash" tag
    return titleCaseName(parts.slice(0, -2));
  }
  if (parts.length >= 3) {
    // "first-last-filename" — first two tokens are the name, rest is discarded
    return titleCaseName(parts.slice(0, 2));
  }
  return titleCaseName(parts);
}

// ===== In-memory game store =====
const games = new Map();

// ===== Open Canvas WebSocket rooms =====
// code -> Set<ws>, one room per game. Lives alongside `games` and is wiped
// the same way (nothing to persist — a deploy already drops in-progress
// games, so dropping live connections too is consistent, not a new gap).
const wsRooms = new Map();

function broadcastToRoom(code, senderWs, payload) {
  const room = wsRooms.get(code);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const client of room) {
    if (client !== senderWs && client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  }
}

// Clean up stale games. 'passthrough' games are designed to sit idle between
// turns for days while a link gets passed along, so they get a much longer
// cutoff based on last activity rather than the normal 24h-since-created rule.
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;
  const passthroughCutoff = now - 30 * 24 * 60 * 60 * 1000;
  for (const [code, game] of games) {
    if (game.mode === 'passthrough' && game.status !== 'completed') {
      if ((game.lastActivityAt || game.createdAt) < passthroughCutoff) games.delete(code);
    } else if (game.createdAt < cutoff) {
      games.delete(code);
    }
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

// Vivid, easy-to-spot-on-white colors for Open Canvas live cursors. Shuffled
// once per game (see shuffledCursorPalette) so assignment order is
// unpredictable but collision-free within a single game, up to 10 players —
// beyond that it cycles and colors repeat, an acceptable edge case.
const CURSOR_PALETTE = ['#ff00ff', '#00e5ff', '#ff8f00', '#00c853', '#ffd600', '#ff1744', '#7c4dff', '#1de9b6', '#ff4081', '#76ff03'];
function shuffledCursorPalette() {
  const arr = CURSOR_PALETTE.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Open Canvas theme suggestion — picked once server-side (not client-side
// like the round modes' per-player inspiration word) specifically so every
// player sees the same word, since they're all drawing on the one canvas
// together rather than separate private sheets.
const THEME_WORDS = [
  'robot', 'pirate', 'wizard', 'octopus', 'dragon', 'cactus', 'astronaut', 'vampire',
  'jellyfish', 'viking', 'mermaid', 'dinosaur', 'clown', 'ninja', 'snail', 'owl',
  'walrus', 'gnome', 'yeti', 'cyborg', 'samurai', 'scarecrow', 'ghost', 'alien',
  'moose', 'flamingo', 'chicken', 'toad', 'spider', 'king', 'queen', 'jester',
  'detective', 'chef', 'cowboy', 'zombie', 'angel', 'fairy', 'troll', 'goblin',
  'knight', 'pharaoh', 'underwater city', 'floating island', 'tiny circus',
  'haunted carnival', 'secret garden', 'lost civilization', 'space market',
];
function randomTheme() {
  return THEME_WORDS[crypto.randomInt(THEME_WORDS.length)];
}

// Shared by the anonymous /join handler and the friend-invite accept handler.
function addPlayerToGame(game, name, userId, emoji) {
  const player = {
    id: crypto.randomUUID(),
    name,
    order: game.players.length + 1,
    submissions: {}, // round -> true
    userId: userId || null,
    // Freeform, not validated against an allowlist — worst case someone sees a
    // couple of stray characters next to their name in the lobby, no real harm.
    emoji: emoji ? String(emoji).trim().slice(0, 8) : null,
    cursorColor: game.cursorPalette[game.players.length % game.cursorPalette.length],
  };
  game.players.push(player);
  return player;
}

const SECTIONS = ['head', 'torso', 'legs']; // section drawn in round 1, 2, 3 (always 3 rounds)

// Rotation: in round r, player p works on sheet ((p - 1 + r - 1) % N), where N
// is the number of players (2 or 3). With 2 players there are only 2 sheets,
// so they simply alternate/swap sheets each round instead of a 3-way rotation.
// 'passthrough' mode uses this exact same rotation — it's the identical N-sheet
// game, just without requiring everyone online together (see /join and /submit).
function sheetForPlayer(playerOrder, round, maxPlayers) {
  return (playerOrder - 1 + round - 1) % maxPlayers;
}

// Any account's uploaded avatar image outranks their picked emoji — same
// as the account page, just surfaced in the lobby's player list too.
function playerIcon(p) {
  if (p.userId) {
    const user = data.getUserById(p.userId);
    if (user && user.avatarDataUrl) {
      return { avatarDataUrl: user.avatarDataUrl, emoji: p.emoji || null };
    }
  }
  return { avatarDataUrl: null, emoji: p.emoji || null };
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
    // Still 'waiting' with an open headcount: maxPlayers is a soft ceiling
    // (not the real target) until the creator hits Start, which locks it to
    // however many actually joined. Lets the client skip drawing "N-of-max"
    // placeholder slots while the roster is still genuinely unknown.
    openHeadcount: game.status === 'waiting' && !!game.openHeadcount,
    timePerTurn: game.timePerTurn,
    round,
    section, // what everyone is drawing this round
    roundStartedAt: game.roundStartedAt || null,
    theme: game.theme || null, // opencanvas only: shared suggestion, same for every player
    // passthrough/opencanvas only: does the creator currently allow any of
    // their friends to join without the code/link (see openGamesForFriend()).
    openToFriends: !!game.openToFriends,
    players: game.players.map(p => ({
      name: p.name,
      order: p.order,
      ...playerIcon(p),
      cursorColor: p.cursorColor || null,
      submitted: round ? !!p.submissions[round] : false,
    })),
    you: null,
  };

  if (player) {
    state.you = {
      name: player.name,
      order: player.order,
      ...playerIcon(player),
      cursorColor: player.cursorColor || null,
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

  // Full reveal only when completed: one sheet per player, each with head/torso/legs.
  // Open Canvas has no rounds/sheets — just the one shared, final flattened image.
  if (game.status === 'completed') {
    if (game.mode === 'opencanvas') {
      state.canvasImage = game.finalImage || null;
    } else {
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
  }

  return state;
}

// Summarizes every in-progress 'passthrough' game a user is a player in —
// backs both the /games/mine listing and the free-tier "one at a time" gate,
// since passthrough is the only mode a player can be quietly mid-way through
// without anyone else around (async/timed games live entirely in one lobby session).
function myActiveGames(userId, excludeCode) {
  const result = [];
  for (const [code, game] of games) {
    if (code === excludeCode) continue;
    if (game.mode !== 'passthrough' || game.status === 'completed') continue;
    const player = game.players.find(p => p.userId === userId);
    if (!player) continue;

    const round = game.round;
    const needsSubmission = !!round && !player.submissions[round];
    let continuingFrom = null;
    if (needsSubmission && round > 1) {
      const sheetIdx = sheetForPlayer(player.order, round, game.maxPlayers);
      const prevSection = game.sheets[sheetIdx][SECTIONS[round - 2]];
      continuingFrom = prevSection ? prevSection.artist : null;
    }

    result.push({
      code,
      playerId: player.id,
      round,
      section: round ? SECTIONS[round - 1] : null,
      needsSubmission,
      waitingForPlayers: game.players.length < game.maxPlayers,
      continuingFrom,
      // Every other artist currently on this chain, in join order — lets the
      // "Open games" list show who's actually joined once someone accepts.
      otherArtists: game.players.filter(p => p.id !== player.id).map(p => p.name),
    });
  }
  return result;
}

// GET /api/friends/open-games — every active passthrough/opencanvas game
// where the creator has flipped "let any friend join" on and the requester
// is actually one of their friends. Relaxed/Timed never show up here — they
// can't accept a player after /start at all, regardless of this flag.
function openGamesForFriend(userId) {
  const result = [];
  for (const [code, game] of games) {
    if (game.status !== 'active' || !game.openToFriends) continue;
    if (game.mode !== 'passthrough' && game.mode !== 'opencanvas') continue;
    // Same relaxed ceiling as the /join handler — an active Open Canvas
    // game's original maxPlayers isn't a hard cap, only passthrough's is.
    const joinCap = game.mode === 'opencanvas' ? 20 : game.maxPlayers;
    if (game.players.length >= joinCap) continue;
    if (game.players.some(p => p.userId === userId)) continue; // already in it

    const creator = game.players[0];
    if (!creator.userId || !data.areFriends(userId, creator.userId)) continue;

    result.push({
      code,
      mode: game.mode,
      creatorName: creator.name,
      playerCount: game.players.length,
      maxPlayers: game.maxPlayers,
    });
  }
  return result;
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
  // GET /api/photos — background photo pool for the auth-screen backdrop,
  // with the contributor's name parsed from each filename.
  if (url.pathname === '/api/photos' && req.method === 'GET') {
    let files = [];
    try {
      files = fs.readdirSync(path.join(__dirname, 'photos')).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
    } catch (e) { /* no photos/ directory yet — empty pool, caller falls back to the gradient */ }
    return json(res, 200, { photos: files.map(f => ({ file: f, credit: creditFromFilename(f) })) });
  }

  // ===== STRIPE/PAYMENTS =====
  // POST /api/stripe/checkout (auth required) — an already-logged-in, free
  // account subscribing to the monthly brush unlock. Not a signup step
  // anymore; accounts exist before this is ever called.
  if (url.pathname === '/api/stripe/checkout' && req.method === 'POST') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      // Raw user record (not the serialized/public shape) — needed for
      // stripeCustomerId, which the public API surface doesn't expose.
      const user = data.getUserById(userId);
      if (!user) return json(res, 404, { error: 'User not found' });
      return (async () => {
        try {
          const session = await payments.createSubscriptionCheckoutSession(user);
          json(res, 201, { url: session.url });
        } catch (e) {
          const status = e.status || 500;
          json(res, status, { error: e.error || e.message });
        }
      })();
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  // POST /api/stripe/portal (auth required) — Stripe-hosted page to manage
  // or cancel an existing subscription.
  if (url.pathname === '/api/stripe/portal' && req.method === 'POST') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      const user = data.getUserById(userId);
      if (!user) return json(res, 404, { error: 'User not found' });
      return (async () => {
        try {
          const session = await payments.createPortalSession(user);
          json(res, 200, { url: session.url });
        } catch (e) {
          const status = e.status || 500;
          json(res, status, { error: e.error || e.message });
        }
      })();
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
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

  // ===== ADMIN =====
  // DELETE /api/admin/users?email=... — secret-gated escape hatch for
  // removing test/spam accounts, since this app has no admin role/dashboard
  // (single-operator hobby app; a whole role system would be more surface
  // area than the problem justifies). Same env-only-secret pattern as
  // BETA_CODE — never a source literal, since this repo is public.
  if (url.pathname === '/api/admin/users' && req.method === 'DELETE') {
    const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
    if (!ADMIN_SECRET) return json(res, 403, { error: 'Admin endpoint is not enabled' });
    if (req.headers['x-admin-secret'] !== ADMIN_SECRET) return json(res, 403, { error: 'Invalid admin secret' });

    const email = url.searchParams.get('email');
    if (!email) return json(res, 400, { error: 'email required' });
    const user = data.getUserByEmail(email);
    if (!user) return json(res, 404, { error: 'User not found' });

    return data.deleteUser(user.id).then(() => {
      json(res, 200, { deleted: true, email });
    }).catch(e => {
      json(res, 500, { error: e.message });
    });
  }

  // ===== AUTH =====
  // POST /api/auth/signup { email, username, password } — free, instant
  // account creation. No payment involved; the account can subscribe (or
  // not) later from the account page.
  if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
    return readBody(req, 10_000, async (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      try {
        const result = await payments.handleFreeSignup(body);
        json(res, 200, result);
      } catch (e) {
        const status = e.status || 500;
        json(res, status, { error: e.error || e.message });
      }
    });
  }

  // POST /api/auth/beta-signup { email, username, password, betaCode }
  // Creates a free account and grants free subscriber status, bypassing
  // Stripe, when BETA_CODE matches.
  if (url.pathname === '/api/auth/beta-signup' && req.method === 'POST') {
    return readBody(req, 10_000, async (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      try {
        const result = await payments.handleBetaSignup(body);
        json(res, 200, result);
      } catch (e) {
        const status = e.status || 500;
        json(res, status, { error: e.error || e.message });
      }
    });
  }

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

  // POST /api/auth/security-question { email } — no email dependency:
  // recovery is a security question set from the account page while logged
  // in. Returns 404 with the same generic message whether the email doesn't
  // exist or just never set one up, so this can't be used to probe accounts.
  if (url.pathname === '/api/auth/security-question' && req.method === 'POST') {
    return readBody(req, 10_000, async (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      try {
        const result = await auth.handleGetSecurityQuestion(body);
        json(res, 200, result);
      } catch (e) {
        const status = e.status || 500;
        json(res, status, { error: e.error || e.message });
      }
    });
  }

  // POST /api/auth/reset-with-answer { email, answer, newPassword } — logs
  // the user in on success (same auto-login pattern as checkout/beta signup)
  if (url.pathname === '/api/auth/reset-with-answer' && req.method === 'POST') {
    return readBody(req, 10_000, async (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      try {
        const result = await auth.handleResetWithAnswer(body);
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

  // DELETE /api/account/me { password } — permanent self-service deletion
  if (url.pathname === '/api/account/me' && req.method === 'DELETE') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return readBody(req, 10_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const result = await auth.handleDeleteAccount(userId, body);
          json(res, 200, result);
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

  if (url.pathname === '/api/account/password' && req.method === 'PUT') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return readBody(req, 10_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const user = await auth.handleUpdatePassword(userId, body);
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

  if (url.pathname === '/api/account/security-question' && req.method === 'PUT') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return readBody(req, 10_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const user = await auth.handleUpdateSecurityQuestion(userId, body);
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
            body.inspirations,
            body.thumbnail
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

  const favPinMatch = url.pathname.match(/^\/api\/account\/favorites\/([a-f0-9-]+)\/pin$/);
  if (favPinMatch && req.method === 'PUT') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      account.togglePinFavorite(userId, favPinMatch[1]).then(user => {
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

  // ===== FRIENDS ENDPOINTS (require auth) =====
  if (url.pathname === '/api/friends' && req.method === 'GET') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return json(res, 200, friends.getFriends(userId));
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  if (url.pathname === '/api/friends/requests' && req.method === 'GET') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return json(res, 200, friends.getFriendRequests(userId));
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  if (url.pathname === '/api/friends/requests' && req.method === 'POST') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return readBody(req, 10_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const result = await friends.sendFriendRequest(userId, body.toUsername);
          json(res, 201, result);
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

  const friendReqActionMatch = url.pathname.match(/^\/api\/friends\/requests\/([a-f0-9-]+)\/(accept|decline)$/);
  if (friendReqActionMatch && req.method === 'POST') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      const otherUserId = friendReqActionMatch[1];
      const fn = friendReqActionMatch[2] === 'accept' ? friends.acceptFriendRequest : friends.declineFriendRequest;
      fn(userId, otherUserId).then(user => {
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

  const unfriendMatch = url.pathname.match(/^\/api\/friends\/([a-f0-9-]+)$/);
  if (unfriendMatch && req.method === 'DELETE') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      friends.removeFriend(userId, unfriendMatch[1]).then(user => {
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

  // GET /api/friends/:userId/profile - requires friendship (or viewing self)
  const profileMatch = url.pathname.match(/^\/api\/friends\/([a-f0-9-]+)\/profile$/);
  if (profileMatch && req.method === 'GET') {
    try {
      const viewerId = auth.extractAndVerifyToken(req);
      return json(res, 200, friends.getProfile(viewerId, profileMatch[1]));
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  // POST /api/friends/:ownerId/profile/comments { text }
  const profileCommentsMatch = url.pathname.match(/^\/api\/friends\/([a-f0-9-]+)\/profile\/comments$/);
  if (profileCommentsMatch && req.method === 'POST') {
    try {
      const authorId = auth.extractAndVerifyToken(req);
      const authorUser = account.getMe(authorId);
      return readBody(req, 10_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const result = await friends.addProfileComment(authorId, authorUser.username, profileCommentsMatch[1], body.text);
          json(res, 201, result);
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

  // DELETE /api/friends/:ownerId/profile/comments/:commentId - owner only
  const profileCommentDeleteMatch = url.pathname.match(/^\/api\/friends\/([a-f0-9-]+)\/profile\/comments\/([a-f0-9-]+)$/);
  if (profileCommentDeleteMatch && req.method === 'DELETE') {
    try {
      const requesterId = auth.extractAndVerifyToken(req);
      friends.removeProfileComment(requesterId, profileCommentDeleteMatch[1], profileCommentDeleteMatch[2]).then(result => {
        json(res, 200, result);
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

  // POST /api/friends/:ownerId/favorites/:favoriteId/comments { text }
  const favCommentsMatch = url.pathname.match(/^\/api\/friends\/([a-f0-9-]+)\/favorites\/([a-f0-9-]+)\/comments$/);
  if (favCommentsMatch && req.method === 'POST') {
    try {
      const authorId = auth.extractAndVerifyToken(req);
      const authorUser = account.getMe(authorId);
      return readBody(req, 10_000, async (err, body) => {
        if (err) return json(res, 400, { error: err.message });
        try {
          const result = await friends.addFavoriteComment(authorId, authorUser.username, favCommentsMatch[1], favCommentsMatch[2], body.text);
          json(res, 201, result);
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

  // DELETE /api/friends/:ownerId/favorites/:favoriteId/comments/:commentId - owner only
  const favCommentDeleteMatch = url.pathname.match(/^\/api\/friends\/([a-f0-9-]+)\/favorites\/([a-f0-9-]+)\/comments\/([a-f0-9-]+)$/);
  if (favCommentDeleteMatch && req.method === 'DELETE') {
    try {
      const requesterId = auth.extractAndVerifyToken(req);
      friends.removeFavoriteComment(requesterId, favCommentDeleteMatch[1], favCommentDeleteMatch[2], favCommentDeleteMatch[3]).then(result => {
        json(res, 200, result);
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

  // GET /api/friends/open-games — active passthrough/opencanvas games where
  // a friend has flipped "let any friend join" on. Distinct from the
  // targeted invite list below (/api/friends/invites) — this is discovery,
  // not a per-person invite the creator sent.
  if (url.pathname === '/api/friends/open-games' && req.method === 'GET') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return json(res, 200, { games: openGamesForFriend(userId) });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  if (url.pathname === '/api/friends/invites' && req.method === 'GET') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return json(res, 200, friends.getGameInvites(userId));
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  const inviteAcceptMatch = url.pathname.match(/^\/api\/friends\/invites\/([a-f0-9-]+)\/accept$/);
  if (inviteAcceptMatch && req.method === 'POST') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      const inviteId = inviteAcceptMatch[1];
      const invite = data.getGameInvite(userId, inviteId);
      if (!invite) return json(res, 404, { error: 'Invite not found' });

      const game = games.get(invite.gameCode);
      const acceptable = game && (game.status === 'waiting' || (game.mode === 'passthrough' && game.status === 'active'));
      if (!acceptable) {
        data.removeGameInvite(userId, inviteId).catch(() => {});
        return json(res, 410, { error: 'This game is no longer available' });
      }
      if (game.players.length >= game.maxPlayers) {
        return json(res, 409, { error: 'Game is full' });
      }

      const user = account.getMe(userId);
      const player = addPlayerToGame(game, user.username, userId);
      game.lastActivityAt = Date.now();
      data.removeGameInvite(userId, inviteId).catch(() => {});
      return json(res, 200, { playerId: player.id, ...publicState(game, player.id) });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  const inviteDeclineMatch = url.pathname.match(/^\/api\/friends\/invites\/([a-f0-9-]+)\/decline$/);
  if (inviteDeclineMatch && req.method === 'POST') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      data.removeGameInvite(userId, inviteDeclineMatch[1]).then(() => {
        json(res, 200, { ok: true });
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

  // ===== GAMES API =====
  // GET /api/games/mine — every in-progress 'passthrough' game the logged-in
  // user is part of, for the "continue a drawing" picker.
  if (url.pathname === '/api/games/mine' && req.method === 'GET') {
    try {
      const userId = auth.extractAndVerifyToken(req);
      return json(res, 200, { games: myActiveGames(userId) });
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.error || e.message });
    }
  }

  // POST /api/games -> create
  if (req.method === 'POST' && url.pathname === '/api/games') {
    return readBody(req, 10_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      const mode = body.mode === 'timed' ? 'timed' : body.mode === 'passthrough' ? 'passthrough' : body.mode === 'opencanvas' ? 'opencanvas' : 'async';
      const timePerTurn = mode === 'timed' ? Math.min(10, Math.max(1, Number(body.timePerTurn) || 3)) : null;
      // Open headcount: the creator doesn't commit to an exact roster up front —
      // anyone with the link can join (up to the same 20-player ceiling as a
      // fixed game) until the creator hits Start, which locks maxPlayers to
      // however many actually showed up. Doesn't apply to 'passthrough' — that
      // mode's 2-3 person rotation is fixed by design.
      const openHeadcount = mode !== 'passthrough' && !!body.openHeadcount;
      // 'passthrough' is the same N-sheet rotation as the other modes, just without
      // requiring everyone online together — capped at 2-3 (default 2) since there
      // are only 3 fixed sections (head/torso/legs) to rotate through.
      const maxPlayers = mode === 'passthrough'
        ? Math.min(3, Math.max(2, Number(body.maxPlayers) || 2))
        : openHeadcount
          ? 20
          : Math.min(20, Math.max(2, Number(body.maxPlayers) || 3)); // 2-20 players (classroom-sized groups)
      const code = generateCode();
      const now = Date.now();
      games.set(code, {
        code,
        status: 'waiting',
        mode,
        openHeadcount,
        timePerTurn,
        maxPlayers,
        players: [],
        sheets: Array.from({ length: maxPlayers }, () => ({})), // sheet -> { head: {image, edgeStrip, artist, inspiration}, torso: ..., legs: ... }
        round: null,
        roundStartedAt: null,
        createdAt: now,
        lastActivityAt: now,
        cursorPalette: shuffledCursorPalette(),
        strokes: [], // opencanvas only: ordered draw-op log, replayed to late joiners over the WebSocket room
        finalImage: null, // opencanvas only: flattened PNG set by /finish
        theme: null, // opencanvas only: shared suggestion word, picked once at /start
        // passthrough/opencanvas only: creator-toggled, lets any of their
        // friends join an active game without needing the code/link — see
        // openGamesForFriend() and the /open-to-friends route below.
        openToFriends: false,
      });
      json(res, 201, { code });
    });
  }

  const match = url.pathname.match(/^\/api\/games\/([A-Z0-9]{6})(?:\/(join|start|submit|invite|cancel|finish|open-to-friends))?$/i);
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
      // set only if the joiner happens to be logged in; anonymous play is unaffected
      const joinerUserId = auth.tryExtractUserId(req);

      // 'passthrough' games stay joinable one at a time as the chain progresses,
      // instead of requiring everyone up front before a 'waiting' lobby closes.
      // 'opencanvas' is the same — anyone with the code/link can join a live
      // canvas, no reason a shared link shouldn't just work. The
      // openToFriends toggle is a separate, additive thing: it's about
      // *discovery* (showing up on a friend's home screen with no link
      // needed at all), not about gatekeeping the link itself.
      const canJoinActive = game.status === 'active' && (game.mode === 'passthrough' || game.mode === 'opencanvas');
      if (game.status !== 'waiting' && !canJoinActive) return json(res, 409, { error: 'Game already started' });
      // Open Canvas's maxPlayers is really just "how many were expected at
      // Start" (can be as low as 1 for a solo/open-headcount start), not a
      // structural cap the way passthrough's fixed 2-3 person rotation is —
      // a live canvas has no real reason to stop accepting new artists once
      // running, so active joins check against the app-wide ceiling instead.
      const joinCap = (game.mode === 'opencanvas' && game.status === 'active') ? 20 : game.maxPlayers;
      if (game.players.length >= joinCap) return json(res, 409, { error: 'Game is full' });
      const name = String(body.name || '').trim().slice(0, 30);
      if (!name) return json(res, 400, { error: 'Name is required' });

      const player = addPlayerToGame(game, name, joinerUserId, body.emoji);
      game.lastActivityAt = Date.now();

      // 'passthrough' has no lobby/Start step — the very first join IS round 1 starting.
      if (game.mode === 'passthrough' && game.status === 'waiting') {
        game.status = 'active';
        game.round = 1;
        game.roundStartedAt = Date.now();
      }

      json(res, 200, { playerId: player.id, ...publicState(game, player.id) });
    });
  }

  // POST /api/games/:code/start { playerId } (creator only)
  if (req.method === 'POST' && action === 'start') {
    return readBody(req, 10_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      const player = game.players.find(p => p.id === body.playerId);
      if (!player || player.order !== 1) return json(res, 403, { error: 'Only the game creator can start' });
      if (game.status !== 'waiting') return json(res, 409, { error: 'Game already started' });
      if (game.openHeadcount) {
        // Locking the roster here, not at creation, is the whole point of this
        // mode — whatever showed up by the time the creator hits Start becomes
        // the real player count the rotation math runs on. Open Canvas has no
        // rotation to fill, so a lone creator can start solo; every other
        // mode still needs a partner to draw/pass sheets with.
        const minPlayers = game.mode === 'opencanvas' ? 1 : 2;
        if (game.players.length < minPlayers) {
          return json(res, 409, { error: `Need at least ${minPlayers} player${minPlayers > 1 ? 's' : ''} to start` });
        }
        game.maxPlayers = game.players.length;
        game.sheets = Array.from({ length: game.maxPlayers }, () => ({}));
        game.openHeadcount = false;
      } else if (game.players.length < game.maxPlayers) {
        return json(res, 409, { error: `Need ${game.maxPlayers} players to start` });
      }
      game.status = 'active';
      // Open Canvas has no rounds — everyone draws on the one shared sheet
      // until someone hits Finish, so there's no round/section to initialize.
      if (game.mode === 'opencanvas') {
        game.round = null;
        game.roundStartedAt = null;
        game.theme = randomTheme();
      } else {
        game.round = 1;
        game.roundStartedAt = Date.now();
      }
      json(res, 200, publicState(game, body.playerId));
    });
  }

  // POST /api/games/:code/invite { playerId, friendUserId } (friends only)
  if (req.method === 'POST' && action === 'invite') {
    return readBody(req, 10_000, async (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      try {
        const userId = auth.extractAndVerifyToken(req);
        const inviter = game.players.find(p => p.id === body.playerId);
        if (!inviter || inviter.userId !== userId) {
          return json(res, 403, { error: 'Unknown player' });
        }

        if (game.mode === 'passthrough') {
          // Any player can invite the next artist once they've had their own turn.
          if (game.status !== 'active') return json(res, 409, { error: 'Game not active' });
          if (game.players.length >= game.maxPlayers) return json(res, 409, { error: 'All artists have already joined' });
        } else {
          // Existing behavior, unchanged: only the creator, only before the game starts.
          if (inviter.order !== 1) return json(res, 403, { error: 'Only the game creator can invite' });
          if (game.status !== 'waiting') return json(res, 409, { error: 'Game already started' });
          if (game.players.length >= game.maxPlayers) return json(res, 409, { error: 'Game is full' });
        }

        const fromUser = account.getMe(userId);
        const result = await friends.inviteToGame(userId, fromUser.username, game.code, body.friendUserId);
        json(res, 201, result);
      } catch (e) {
        const status = e.status || 500;
        json(res, status, { error: e.error || e.message });
      }
    });
  }

  // POST /api/games/:code/cancel { playerId } — lets a participant abandon a
  // stalled game (e.g. a 'passthrough' invite that never got accepted) instead
  // of polling forever. Deletes the game outright, so a late joiner hitting a
  // stale invite link afterward gets a clean "not found" instead of an orphaned game.
  if (req.method === 'POST' && action === 'cancel') {
    return readBody(req, 10_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      const player = game.players.find(p => p.id === body.playerId);
      if (!player) return json(res, 403, { error: 'Unknown player' });
      if (game.status === 'completed') return json(res, 409, { error: 'Game already completed' });
      games.delete(code);
      json(res, 200, { cancelled: true });
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
      game.lastActivityAt = Date.now();

      // Advance once everyone currently expected has submitted. The extra
      // players.length===maxPlayers check matters for 'passthrough': its other
      // modes always have a full roster by the time status is 'active' (enforced
      // by /start), but passthrough can reach round 1 with only 1 of maxPlayers
      // joined so far, and must not advance until everyone has actually joined in.
      const allSubmitted = game.players.length === game.maxPlayers && game.players.every(p => p.submissions[game.round]);
      if (allSubmitted) {
        if (game.round >= 3) {
          game.status = 'completed';
          game.round = null;
          game.completedAt = Date.now();
          // Fire-and-forget: bump the "played together" counter for every logged-in
          // pair. A lost increment on a rare crash is an acceptable stat inaccuracy.
          data.recordGamesPlayedTogether(game.players.map(p => p.userId)).catch(() => {});
        } else {
          game.round += 1;
          game.roundStartedAt = Date.now();
        }
      }
      json(res, 200, publicState(game, body.playerId));
    });
  }

  // POST /api/games/:code/finish { playerId, image } — Open Canvas only.
  // Same creator-only pattern as /start: only the player who created the
  // game can end it for everyone. The finisher's client sends its own
  // current flattened canvas as the authoritative result; other clients may
  // be a network round-trip behind, an acceptable trade-off for not needing
  // a server-side canvas renderer.
  if (req.method === 'POST' && action === 'finish') {
    return readBody(req, 8_000_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      if (game.mode !== 'opencanvas') return json(res, 400, { error: 'Not an Open Canvas game' });
      if (game.status !== 'active') return json(res, 409, { error: 'Game is not active' });
      const player = game.players.find(p => p.id === body.playerId);
      if (!player) return json(res, 403, { error: 'Unknown player' });
      if (player.order !== 1) return json(res, 403, { error: 'Only the game creator can finish' });

      const image = String(body.image || '');
      if (!image.startsWith('data:image/png;base64,')) {
        return json(res, 400, { error: 'Invalid image' });
      }

      game.finalImage = image;
      game.status = 'completed';
      game.completedAt = Date.now();
      data.recordGamesPlayedTogether(game.players.map(p => p.userId)).catch(() => {});
      broadcastToRoom(code, null, { type: 'finished' });
      json(res, 200, publicState(game, body.playerId));
    });
  }

  // PUT /api/games/:code/open-to-friends { playerId, open } (creator only)
  // — passthrough/opencanvas only. Lets any of the creator's friends join
  // an active game without the code/link (see openGamesForFriend()); an
  // additive path for passthrough (which already allows link-based joins
  // while active), the only path at all for opencanvas (which otherwise
  // blocks joining once active).
  if (req.method === 'PUT' && action === 'open-to-friends') {
    return readBody(req, 10_000, (err, body) => {
      if (err) return json(res, 400, { error: err.message });
      if (game.mode !== 'passthrough' && game.mode !== 'opencanvas') {
        return json(res, 400, { error: 'Not available for this game mode' });
      }
      const player = game.players.find(p => p.id === body.playerId);
      if (!player || player.order !== 1) return json(res, 403, { error: 'Only the game creator can change this' });
      if (game.status !== 'active') return json(res, 409, { error: 'Game is not active' });

      game.openToFriends = !!body.open;
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

// ===== Open Canvas WebSocket =====
// A raw upgrade handled outside the /api HTTP routes — real-time stroke
// broadcast for the shared-whiteboard mode. Everything else in this app is
// 2s-poll based, which is fine for turn state but too slow for "show my line
// the instant I draw it" with several people drawing at once.
const wss = new WebSocketServer({ noServer: true, maxPayload: 20_000 });

// Caps memory for a runaway/abusive client — not a real ceiling for normal use.
const MAX_STROKE_HISTORY = 20_000;

wss.on('connection', (ws, code, player) => {
  ws.gameCode = code;
  // Broadcasts are tagged with the player's public `order`, never their
  // internal id — that id doubles as an auth token for /submit, /cancel,
  // /finish etc. (any player who knew it could act as another player), so it
  // must never be sent to other clients in the room.
  ws.order = player.order;
  let room = wsRooms.get(code);
  if (!room) { room = new Set(); wsRooms.set(code, room); }
  room.add(ws);

  // Replay everything drawn so far so a late joiner's canvas matches
  // everyone else's before live strokes start streaming in.
  const game = games.get(code);
  if (game) {
    try { ws.send(JSON.stringify({ type: 'history', strokes: game.strokes })); } catch (e) { /* connection already gone */ }
  }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const g = games.get(code);
    if (!g || g.status !== 'active') return;

    if (msg.type === 'stroke' || msg.type === 'fill' || msg.type === 'airbrush' || msg.type === 'stamp') {
      // Persisted (unlike cursor position) so a late joiner's replay
      // reconstructs the same canvas everyone else is looking at.
      if (g.strokes.length < MAX_STROKE_HISTORY) {
        g.strokes.push({ ...msg, order: ws.order });
      }
      g.lastActivityAt = Date.now();
      broadcastToRoom(code, ws, { ...msg, order: ws.order });
    } else if (msg.type === 'cursor') {
      broadcastToRoom(code, ws, { type: 'cursor', order: ws.order, x: msg.x, y: msg.y });
    }
  });

  ws.on('close', () => {
    room.delete(ws);
    if (room.size === 0) wsRooms.delete(code);
    broadcastToRoom(code, ws, { type: 'presence', order: ws.order, connected: false });
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws/canvas') { socket.destroy(); return; }

  const code = (url.searchParams.get('code') || '').toUpperCase();
  const playerId = url.searchParams.get('playerId') || '';
  const game = games.get(code);
  const player = game && game.players.find(p => p.id === playerId);
  if (!game || game.mode !== 'opencanvas' || !player) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, code, player);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Exquisite Corpse server running at http://localhost:${PORT}/`);
});
