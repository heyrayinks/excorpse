const data = require('./data');

// Helper to serialize user for API response
function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    avatarDataUrl: user.avatarDataUrl,
    paid: user.paid,
    favorites: user.favorites,
    favoritesCount: user.favorites.length,
    friendsCount: user.friends.length,
    pendingRequestsReceived: user.friendRequestsReceived.length,
    profileComments: user.profileComments,
    securityQuestion: user.securityQuestion || null, // question text only — never the answer hash
  };
}

exports.serializeUser = serializeUser;

// GET /api/account/me - Get logged-in user
exports.getMe = (userId) => {
  const user = data.getUserById(userId);
  if (!user) {
    throw { status: 404, error: 'User not found' };
  }
  return serializeUser(user);
};

// PUT /api/account/username - Update username
exports.updateUsername = (userId, newUsername) => {
  if (!newUsername || newUsername.length < 3 || newUsername.length > 30) {
    throw { status: 400, error: 'Username must be 3-30 characters' };
  }

  return data.updateUser(userId, { username: newUsername })
    .then(user => serializeUser(user));
};

// PUT /api/account/avatar - Upload avatar (client pre-crops to 50x50)
exports.updateAvatar = (userId, dataUrl) => {
  // Validate it's a data URL
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
    throw { status: 400, error: 'Avatar must be a base64 PNG data URL' };
  }

  // Sanity check size (50x50 PNG should be <50KB)
  if (dataUrl.length > 100 * 1024) {
    throw { status: 400, error: 'Avatar image too large' };
  }

  return data.updateUser(userId, { avatarDataUrl: dataUrl })
    .then(user => serializeUser(user));
};

// PUT /api/account/password - Update password (already-hashed by auth.js,
// which owns the hashing logic — this stays a plain persistence step)
exports.updatePassword = (userId, passwordHash, passwordSalt) => {
  return data.updateUser(userId, { passwordHash, passwordSalt })
    .then(user => serializeUser(user));
};

// PUT /api/account/security-question - Set/change the password-recovery
// question (already-hashed answer, same split as updatePassword above)
exports.updateSecurityQuestion = (userId, question, answerHash, answerSalt) => {
  return data.updateUser(userId, {
    securityQuestion: question,
    securityAnswerHash: answerHash,
    securityAnswerSalt: answerSalt,
  }).then(user => serializeUser(user));
};

// POST /api/account/favorites - Save a drawing to favorites
exports.addFavorite = (userId, image, gameCode, artists, inspirations) => {
  // Validate image is a data URL
  if (!image || !image.startsWith('data:image/png;base64,')) {
    throw { status: 400, error: 'Image must be a base64 PNG data URL' };
  }

  // Sanity check size (should be < 8MB, matching server's readBody limit)
  if (image.length > 8 * 1024 * 1024) {
    throw { status: 400, error: 'Image too large' };
  }

  // Validate other fields
  if (!gameCode || typeof gameCode !== 'string') {
    throw { status: 400, error: 'Game code required' };
  }
  if (!Array.isArray(artists) || artists.length !== 3) {
    throw { status: 400, error: 'Must have 3 artists' };
  }
  if (!Array.isArray(inspirations) || inspirations.length !== 3) {
    throw { status: 400, error: 'Must have 3 inspirations' };
  }

  return data.addFavorite(userId, image, gameCode, artists, inspirations)
    .then(({ user }) => serializeUser(user))
    .catch(err => {
      if (err.message.includes('favorites (max limit)')) {
        throw { status: 409, error: err.message };
      }
      throw err;
    });
};

// DELETE /api/account/favorites/:favoriteId - Remove a favorite
exports.removeFavorite = (userId, favoriteId) => {
  return data.removeFavorite(userId, favoriteId)
    .then(user => serializeUser(user));
};

// PUT /api/account/favorites/:favoriteId/pin - Toggle pinning to the account
// page's background wallpaper (max 2 pinned, see data.js for bump behavior)
exports.togglePinFavorite = (userId, favoriteId) => {
  return data.togglePinFavorite(userId, favoriteId)
    .then(user => serializeUser(user));
};
