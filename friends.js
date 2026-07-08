const data = require('./data');
const account = require('./account');

// GET /api/friends - full friends list, sorted by games played together (desc)
exports.getFriends = (userId) => {
  const user = data.getUserById(userId);
  if (!user) throw { status: 404, error: 'User not found' };

  const friends = user.friends
    .map(f => {
      const friendUser = data.getUserById(f.userId);
      if (!friendUser) return null;
      return {
        id: friendUser.id,
        username: friendUser.username,
        avatarDataUrl: friendUser.avatarDataUrl,
        since: f.since,
        gamesPlayedTogether: user.gamesPlayedWith[friendUser.id] || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.gamesPlayedTogether - a.gamesPlayedTogether);

  return { friends };
};

// GET /api/friends/requests - pending incoming + outgoing
exports.getFriendRequests = (userId) => {
  const user = data.getUserById(userId);
  if (!user) throw { status: 404, error: 'User not found' };

  const hydrate = r => {
    const u = data.getUserById(r.userId);
    return u ? { userId: u.id, username: u.username, avatarDataUrl: u.avatarDataUrl, sentAt: r.sentAt } : null;
  };

  return {
    incoming: user.friendRequestsReceived.map(hydrate).filter(Boolean),
    outgoing: user.friendRequestsSent.map(hydrate).filter(Boolean),
  };
};

// POST /api/friends/requests { toUsername }
exports.sendFriendRequest = (userId, toUsername) => {
  if (!toUsername || typeof toUsername !== 'string') {
    throw { status: 400, error: 'Username required' };
  }

  return data.sendFriendRequest(userId, toUsername)
    .then(({ user, autoAccepted }) => ({ user: account.serializeUser(user), autoAccepted }))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 409, error: err.message };
    });
};

// POST /api/friends/requests/:userId/accept
exports.acceptFriendRequest = (userId, otherUserId) => {
  return data.acceptFriendRequest(userId, otherUserId)
    .then(user => account.serializeUser(user))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 409, error: err.message };
    });
};

// POST /api/friends/requests/:userId/decline
exports.declineFriendRequest = (userId, otherUserId) => {
  return data.declineFriendRequest(userId, otherUserId)
    .then(user => account.serializeUser(user))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 409, error: err.message };
    });
};

// DELETE /api/friends/:userId
exports.removeFriend = (userId, otherUserId) => {
  return data.removeFriend(userId, otherUserId)
    .then(user => account.serializeUser(user))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 409, error: err.message };
    });
};

// ===== Profile + comments =====

function serializeComment(c) {
  return { id: c.id, authorId: c.authorId, authorUsername: c.authorUsername, text: c.text, createdAt: c.createdAt };
}

// GET /api/friends/:userId/profile - requires friendship
exports.getProfile = (viewerId, ownerId) => {
  const owner = data.getUserById(ownerId);
  if (!owner) throw { status: 404, error: 'User not found' };
  if (viewerId !== ownerId && !data.areFriends(viewerId, ownerId)) {
    throw { status: 403, error: 'You must be friends to view this profile' };
  }

  return {
    id: owner.id,
    username: owner.username,
    avatarDataUrl: owner.avatarDataUrl,
    favorites: owner.favorites.map(f => ({
      id: f.id, image: f.image, gameCode: f.gameCode, artists: f.artists,
      inspirations: f.inspirations, savedAt: f.savedAt,
      comments: f.comments.map(serializeComment),
    })),
    profileComments: owner.profileComments.map(serializeComment),
  };
};

function validateCommentText(text) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw { status: 400, error: 'Comment text required' };
  }
  if (text.length > 500) {
    throw { status: 400, error: 'Comment too long (max 500 characters)' };
  }
  return text.trim();
}

// POST /api/friends/:ownerId/favorites/:favoriteId/comments
exports.addFavoriteComment = (authorId, authorUsername, ownerId, favoriteId, text) => {
  const clean = validateCommentText(text);
  if (authorId !== ownerId && !data.areFriends(authorId, ownerId)) {
    throw { status: 403, error: 'You must be friends to comment' };
  }
  return data.addFavoriteComment(ownerId, favoriteId, authorId, authorUsername, clean)
    .then(({ favorite }) => ({ favoriteId: favorite.id, comments: favorite.comments.map(serializeComment) }))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 404, error: err.message };
    });
};

// DELETE /api/friends/:ownerId/favorites/:favoriteId/comments/:commentId - owner only
exports.removeFavoriteComment = (requesterId, ownerId, favoriteId, commentId) => {
  if (requesterId !== ownerId) {
    throw { status: 403, error: 'Only the owner can delete this comment' };
  }
  return data.removeFavoriteComment(ownerId, favoriteId, commentId)
    .then(favorite => ({ favoriteId: favorite.id, comments: favorite.comments.map(serializeComment) }))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 404, error: err.message };
    });
};

// POST /api/friends/:ownerId/profile/comments
exports.addProfileComment = (authorId, authorUsername, ownerId, text) => {
  const clean = validateCommentText(text);
  if (authorId !== ownerId && !data.areFriends(authorId, ownerId)) {
    throw { status: 403, error: 'You must be friends to comment' };
  }
  return data.addProfileComment(ownerId, authorId, authorUsername, clean)
    .then(({ owner }) => ({ profileComments: owner.profileComments.map(serializeComment) }))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 404, error: err.message };
    });
};

// DELETE /api/friends/:ownerId/profile/comments/:commentId - owner only
exports.removeProfileComment = (requesterId, ownerId, commentId) => {
  if (requesterId !== ownerId) {
    throw { status: 403, error: 'Only the owner can delete this comment' };
  }
  return data.removeProfileComment(ownerId, commentId)
    .then(owner => ({ profileComments: owner.profileComments.map(serializeComment) }))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 404, error: err.message };
    });
};

// ===== Game invites =====

// GET /api/friends/invites
exports.getGameInvites = (userId) => {
  const user = data.getUserById(userId);
  if (!user) throw { status: 404, error: 'User not found' };
  return { invites: user.gameInvites };
};

// Called from server.js's /api/games/:code/invite handler (which already
// validated the requester is the game's creator) — this just enforces friendship.
exports.inviteToGame = (fromUserId, fromUsername, gameCode, toFriendUserId) => {
  if (!toFriendUserId) throw { status: 400, error: 'friendUserId required' };
  if (!data.areFriends(fromUserId, toFriendUserId)) {
    throw { status: 403, error: 'You can only invite friends' };
  }
  return data.addGameInvite(toFriendUserId, gameCode, fromUserId, fromUsername)
    .then(invite => ({ invite }))
    .catch(err => {
      if (err.status) throw err;
      throw { status: 404, error: err.message };
    });
};
