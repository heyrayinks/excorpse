const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MAX_FAVORITES = 15;
exports.MAX_FAVORITES = MAX_FAVORITES;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Write queue - ensures serialized writes to users.json.
// IMPORTANT: a rejected fn() must not poison the queue for future callers —
// the stored `writeQueue` is always neutralized to resolved, while the actual
// result/rejection of this call is returned separately to its caller.
let writeQueue = Promise.resolve();

function queue(fn) {
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => {});
  return result;
}

// Initialize users.json if it doesn't exist
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
}

// Backfills fields added after a user's account was created, so older
// records don't need a one-time migration script.
function normalizeUser(user) {
  if (!user.friends) user.friends = [];
  if (!user.friendRequestsSent) user.friendRequestsSent = [];
  if (!user.friendRequestsReceived) user.friendRequestsReceived = [];
  if (!user.gamesPlayedWith) user.gamesPlayedWith = {};
  if (!user.profileComments) user.profileComments = [];
  if (!user.gameInvites) user.gameInvites = [];
  if (Array.isArray(user.favorites)) {
    user.favorites.forEach(f => { if (!f.comments) f.comments = []; });
  }
  return user;
}

function readUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    parsed.users.forEach(normalizeUser);
    return parsed;
  } catch (err) {
    console.error('Error reading users.json:', err);
    return { users: [] };
  }
}

function writeUsers(data) {
  return new Promise((resolve, reject) => {
    const tempFile = USERS_FILE + '.tmp';
    const content = JSON.stringify(data, null, 2);

    fs.writeFile(tempFile, content, 'utf-8', (err) => {
      if (err) return reject(err);
      renameWithRetry(tempFile, USERS_FILE, 5, resolve, reject);
    });
  });
}

// This project lives in a Dropbox-synced folder — Dropbox's sync process can
// transiently hold a lock on users.json (Windows EPERM/EBUSY on rename).
// Retry a few times with a short backoff before giving up.
function renameWithRetry(from, to, attemptsLeft, resolve, reject) {
  fs.rename(from, to, (err) => {
    if (!err) return resolve();
    if (attemptsLeft <= 1 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) return reject(err);
    setTimeout(() => renameWithRetry(from, to, attemptsLeft - 1, resolve, reject), 50);
  });
}

// Public API

exports.getUserByEmail = (email) => {
  const { users } = readUsers();
  return users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
};

exports.getUserById = (id) => {
  const { users } = readUsers();
  return users.find(u => u.id === id) || null;
};

exports.getUserByUsername = (username) => {
  const { users } = readUsers();
  return users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
};

exports.createUser = (email, username, passwordHash, passwordSalt, stripeCustomerId, stripeCheckoutSessionId, signupMethod = 'stripe', securityQuestion = null, securityAnswerHash = null, securityAnswerSalt = null) => {
  return queue(() => {
    const data = readUsers();
    // Re-validate on write (defensive)
    if (data.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      throw new Error('Email already exists');
    }
    if (data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('Username already taken');
    }

    const user = {
      id: crypto.randomUUID(),
      email,
      username,
      passwordHash,
      passwordSalt,
      avatarDataUrl: null,
      paid: true, // Only created after Stripe confirms payment (or a valid beta code)
      signupMethod, // 'stripe' | 'beta' — for tracking how the account was unlocked
      stripeCustomerId,
      stripeCheckoutSessionId,
      createdAt: Date.now(),
      favorites: [],
      // Password reset uses a security question instead of email — this app
      // has nothing sensitive enough to warrant email-verification infra.
      securityQuestion,
      securityAnswerHash,
      securityAnswerSalt,
    };
    normalizeUser(user);

    data.users.push(user);
    return writeUsers(data).then(() => user);
  });
};

exports.updateUser = (id, updates) => {
  return queue(() => {
    const data = readUsers();
    const user = data.users.find(u => u.id === id);
    if (!user) throw new Error('User not found');

    // Validate username uniqueness if changing
    if (updates.username && updates.username !== user.username) {
      if (data.users.some(u => u.id !== id && u.username.toLowerCase() === updates.username.toLowerCase())) {
        throw new Error('Username already taken');
      }
    }

    Object.assign(user, updates);
    return writeUsers(data).then(() => user);
  });
};

exports.addFavorite = (userId, image, gameCode, artists, inspirations) => {
  return queue(() => {
    const data = readUsers();
    const user = data.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');

    if (user.favorites.length >= MAX_FAVORITES) {
      throw new Error(`Already have ${MAX_FAVORITES} favorites (max limit)`);
    }

    const favorite = {
      id: crypto.randomUUID(),
      image,
      gameCode,
      artists,
      inspirations,
      savedAt: Date.now(),
      pinnedAt: null,
    };

    user.favorites.push(favorite);
    return writeUsers(data).then(() => ({ user, favorite }));
  });
};

exports.removeFavorite = (userId, favoriteId) => {
  return queue(() => {
    const data = readUsers();
    const user = data.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');

    user.favorites = user.favorites.filter(f => f.id !== favoriteId);
    return writeUsers(data).then(() => user);
  });
};

// Pins a favorite to the account page's background wallpaper (max 2 — first
// pinned reads on the left, second on the right, by pin order). Pinning a
// 3rd bumps whichever was pinned first rather than blocking, since that's
// the least-surprising behavior with only two slots.
exports.togglePinFavorite = (userId, favoriteId) => {
  return queue(() => {
    const data = readUsers();
    const user = data.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    const favorite = user.favorites.find(f => f.id === favoriteId);
    if (!favorite) throw new Error('Favorite not found');

    if (favorite.pinnedAt) {
      favorite.pinnedAt = null;
    } else {
      const pinned = user.favorites.filter(f => f.pinnedAt).sort((a, b) => a.pinnedAt - b.pinnedAt);
      if (pinned.length >= 2) pinned[0].pinnedAt = null;
      favorite.pinnedAt = Date.now();
    }

    return writeUsers(data).then(() => user);
  });
};

// For webhook verification: find user by Stripe checkout session ID
exports.getUserByCheckoutSessionId = (sessionId) => {
  const { users } = readUsers();
  return users.find(u => u.stripeCheckoutSessionId === sessionId) || null;
};

// Mark session ID on a pending user (before payment confirmed)
// In this design, pending users don't exist on disk until webhook fires
// So this is mainly for Stripe metadata storage; webhook creates the user

// ===== Friends =====

exports.sendFriendRequest = (fromUserId, toUsername) => {
  return queue(() => {
    const data = readUsers();
    const fromUser = data.users.find(u => u.id === fromUserId);
    if (!fromUser) throw new Error('User not found');
    const toUser = data.users.find(u => u.username.toLowerCase() === toUsername.toLowerCase());
    if (!toUser) throw new Error('No user with that username');
    if (toUser.id === fromUserId) throw new Error('Cannot friend yourself');
    if (fromUser.friends.some(f => f.userId === toUser.id)) throw new Error('Already friends');
    if (fromUser.friendRequestsSent.some(r => r.userId === toUser.id)) throw new Error('Request already sent');

    // Crossing requests: the other person already requested us — auto-accept instead of erroring.
    const crossingIdx = fromUser.friendRequestsReceived.findIndex(r => r.userId === toUser.id);
    if (crossingIdx !== -1) {
      const since = Date.now();
      fromUser.friendRequestsReceived.splice(crossingIdx, 1);
      toUser.friendRequestsSent = toUser.friendRequestsSent.filter(r => r.userId !== fromUserId);
      fromUser.friends.push({ userId: toUser.id, since });
      toUser.friends.push({ userId: fromUserId, since });
      return writeUsers(data).then(() => ({ user: fromUser, autoAccepted: true }));
    }

    const sentAt = Date.now();
    fromUser.friendRequestsSent.push({ userId: toUser.id, sentAt });
    toUser.friendRequestsReceived.push({ userId: fromUserId, sentAt });
    return writeUsers(data).then(() => ({ user: fromUser, autoAccepted: false }));
  });
};

exports.acceptFriendRequest = (userId, otherUserId) => {
  return queue(() => {
    const data = readUsers();
    const user = data.users.find(u => u.id === userId);
    const other = data.users.find(u => u.id === otherUserId);
    if (!user) throw new Error('User not found');
    const idx = user.friendRequestsReceived.findIndex(r => r.userId === otherUserId);
    if (idx === -1) throw new Error('No pending request from this user');
    const since = Date.now();
    user.friendRequestsReceived.splice(idx, 1);
    user.friends.push({ userId: otherUserId, since });
    if (other) {
      other.friendRequestsSent = other.friendRequestsSent.filter(r => r.userId !== userId);
      other.friends.push({ userId, since });
    }
    return writeUsers(data).then(() => user);
  });
};

exports.declineFriendRequest = (userId, otherUserId) => {
  return queue(() => {
    const data = readUsers();
    const user = data.users.find(u => u.id === userId);
    const other = data.users.find(u => u.id === otherUserId);
    if (!user) throw new Error('User not found');
    const before = user.friendRequestsReceived.length;
    user.friendRequestsReceived = user.friendRequestsReceived.filter(r => r.userId !== otherUserId);
    if (user.friendRequestsReceived.length === before) throw new Error('No pending request from this user');
    if (other) other.friendRequestsSent = other.friendRequestsSent.filter(r => r.userId !== userId);
    return writeUsers(data).then(() => user);
  });
};

exports.removeFriend = (userId, otherUserId) => {
  return queue(() => {
    const data = readUsers();
    const user = data.users.find(u => u.id === userId);
    const other = data.users.find(u => u.id === otherUserId);
    if (!user) throw new Error('User not found');
    user.friends = user.friends.filter(f => f.userId !== otherUserId);
    if (other) other.friends = other.friends.filter(f => f.userId !== userId);
    return writeUsers(data).then(() => user);
  });
};

exports.areFriends = (userId, otherUserId) => {
  const { users } = readUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return false;
  return user.friends.some(f => f.userId === otherUserId);
};

exports.recordGamesPlayedTogether = (userIds) => {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length < 2) return Promise.resolve();
  return queue(() => {
    const data = readUsers();
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = data.users.find(u => u.id === unique[i]);
        const b = data.users.find(u => u.id === unique[j]);
        if (!a || !b) continue;
        a.gamesPlayedWith[unique[j]] = (a.gamesPlayedWith[unique[j]] || 0) + 1;
        b.gamesPlayedWith[unique[i]] = (b.gamesPlayedWith[unique[i]] || 0) + 1;
      }
    }
    return writeUsers(data);
  });
};

// ===== Comments (favorites + profile) =====

exports.addFavoriteComment = (ownerId, favoriteId, authorId, authorUsername, text) => {
  return queue(() => {
    const data = readUsers();
    const owner = data.users.find(u => u.id === ownerId);
    if (!owner) throw new Error('User not found');
    const favorite = owner.favorites.find(f => f.id === favoriteId);
    if (!favorite) throw new Error('Favorite not found');
    const comment = { id: crypto.randomUUID(), authorId, authorUsername, text, createdAt: Date.now() };
    favorite.comments.push(comment);
    return writeUsers(data).then(() => ({ owner, favorite, comment }));
  });
};

exports.removeFavoriteComment = (ownerId, favoriteId, commentId) => {
  return queue(() => {
    const data = readUsers();
    const owner = data.users.find(u => u.id === ownerId);
    if (!owner) throw new Error('User not found');
    const favorite = owner.favorites.find(f => f.id === favoriteId);
    if (!favorite) throw new Error('Favorite not found');
    favorite.comments = favorite.comments.filter(c => c.id !== commentId);
    return writeUsers(data).then(() => favorite);
  });
};

exports.addProfileComment = (ownerId, authorId, authorUsername, text) => {
  return queue(() => {
    const data = readUsers();
    const owner = data.users.find(u => u.id === ownerId);
    if (!owner) throw new Error('User not found');
    const comment = { id: crypto.randomUUID(), authorId, authorUsername, text, createdAt: Date.now() };
    owner.profileComments.push(comment);
    return writeUsers(data).then(() => ({ owner, comment }));
  });
};

exports.removeProfileComment = (ownerId, commentId) => {
  return queue(() => {
    const data = readUsers();
    const owner = data.users.find(u => u.id === ownerId);
    if (!owner) throw new Error('User not found');
    owner.profileComments = owner.profileComments.filter(c => c.id !== commentId);
    return writeUsers(data).then(() => owner);
  });
};

// ===== Game invites =====

exports.addGameInvite = (toUserId, gameCode, fromUserId, fromUsername) => {
  return queue(() => {
    const data = readUsers();
    const toUser = data.users.find(u => u.id === toUserId);
    if (!toUser) throw new Error('User not found');
    const invite = { id: crypto.randomUUID(), gameCode, fromUserId, fromUsername, createdAt: Date.now() };
    toUser.gameInvites.push(invite);
    return writeUsers(data).then(() => invite);
  });
};

exports.removeGameInvite = (userId, inviteId) => {
  return queue(() => {
    const data = readUsers();
    const user = data.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    const invite = user.gameInvites.find(i => i.id === inviteId) || null;
    user.gameInvites = user.gameInvites.filter(i => i.id !== inviteId);
    return writeUsers(data).then(() => invite);
  });
};

exports.getGameInvite = (userId, inviteId) => {
  const { users } = readUsers();
  const user = users.find(u => u.id === userId);
  if (!user) return null;
  return user.gameInvites.find(i => i.id === inviteId) || null;
};
