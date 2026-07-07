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

function readUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(data);
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

exports.createUser = (email, username, passwordHash, passwordSalt, stripeCustomerId, stripeCheckoutSessionId) => {
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
      paid: true, // Only created after Stripe confirms payment
      stripeCustomerId,
      stripeCheckoutSessionId,
      createdAt: Date.now(),
      favorites: [],
    };

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

// For webhook verification: find user by Stripe checkout session ID
exports.getUserByCheckoutSessionId = (sessionId) => {
  const { users } = readUsers();
  return users.find(u => u.stripeCheckoutSessionId === sessionId) || null;
};

// Mark session ID on a pending user (before payment confirmed)
// In this design, pending users don't exist on disk until webhook fires
// So this is mainly for Stripe metadata storage; webhook creates the user
