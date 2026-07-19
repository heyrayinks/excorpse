const crypto = require('crypto');
const data = require('./data');
const account = require('./account');

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET not set in .env or environment');
}

// Password hashing with scrypt
exports.hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return {
    passwordHash: hash.toString('hex'),
    passwordSalt: salt.toString('hex'),
  };
};

exports.verifyPassword = (password, storedHash, storedSalt) => {
  const salt = Buffer.from(storedSalt, 'hex');
  const hash = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(hash, Buffer.from(storedHash, 'hex'));
};

// Session token: base64url(payload) + "." + base64url(hmac)
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function unbase64url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(str, 'base64');
}

exports.signToken = (userId) => {
  const payload = {
    uid: userId,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64url(Buffer.from(payloadJson));

  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(payloadB64);
  const signature = base64url(hmac.digest());

  return `${payloadB64}.${signature}`;
};

exports.verifyToken = (token) => {
  try {
    const [payloadB64, signature] = token.split('.');
    if (!payloadB64 || !signature) return null;

    const hmac = crypto.createHmac('sha256', SESSION_SECRET);
    hmac.update(payloadB64);
    const expectedSig = base64url(hmac.digest());

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null;
    }

    const payload = JSON.parse(unbase64url(payloadB64).toString('utf-8'));
    if (payload.exp < Date.now()) return null; // expired

    return payload.uid;
  } catch (err) {
    return null;
  }
};

// Extract and verify Bearer token (raw http, not Express middleware)
exports.extractAndVerifyToken = (req) => {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    throw { status: 401, error: 'Missing authorization' };
  }

  const userId = exports.verifyToken(match[1]);
  if (!userId) {
    throw { status: 401, error: 'Invalid token' };
  }

  return userId;
};

// Best-effort identity check for endpoints that work with or without auth
// (anonymous game creation/joining). Never throws — returns null on any
// missing/invalid token instead, so callers don't need to special-case auth.
exports.tryExtractUserId = (req) => {
  try {
    return exports.extractAndVerifyToken(req);
  } catch (err) {
    return null;
  }
};

// Login endpoint logic — email only. Username is a mutable display identity
// (renameable in account settings), so keying login off it meant a rename
// silently broke anyone whose browser had autofilled the old username.
exports.handleLogin = async (body) => {
  const { email, password } = body;
  if (!email || !password) {
    throw { status: 400, error: 'Email and password required' };
  }

  const user = data.getUserByEmail(email);
  if (!user) {
    throw { status: 401, error: 'Invalid credentials' };
  }

  try {
    if (!exports.verifyPassword(password, user.passwordHash, user.passwordSalt)) {
      throw { status: 401, error: 'Invalid credentials' };
    }
  } catch (err) {
    if (err.status) throw err;
    throw { status: 500, error: 'Authentication error' };
  }

  const token = exports.signToken(user.id);
  return {
    token,
    user: account.serializeUser(user),
  };
};

// Normalizes a security answer before hashing/comparing (case/whitespace
// shouldn't matter — "Fluffy" and " fluffy " are the same answer to a user).
function normalizeAnswer(answer) {
  return String(answer || '').trim().toLowerCase();
}

// No email involved — nothing in this app is sensitive enough to warrant
// email-verification infra. Recovery is a security question set from the
// account page while logged in (see account.js's updateSecurityQuestion).
// Always responds the same way whether or not the email is registered —
// otherwise the endpoint becomes a way to check which emails have accounts.
exports.handleGetSecurityQuestion = async (body) => {
  const { email } = body;
  if (!email) {
    throw { status: 400, error: 'Email required' };
  }

  const user = data.getUserByEmail(email);
  if (!user || !user.securityQuestion) {
    throw { status: 404, error: 'No recovery option is set up for that email.' };
  }

  return { question: user.securityQuestion };
};

exports.handleResetWithAnswer = async (body) => {
  const { email, answer, newPassword } = body;
  if (!email || !answer || !newPassword) {
    throw { status: 400, error: 'Email, answer, and new password required' };
  }
  if (newPassword.length < 8) {
    throw { status: 400, error: 'Password must be at least 8 characters' };
  }

  const user = data.getUserByEmail(email);
  if (!user || !user.securityQuestion) {
    throw { status: 400, error: 'No recovery option is set up for that email.' };
  }

  if (!exports.verifyPassword(normalizeAnswer(answer), user.securityAnswerHash, user.securityAnswerSalt)) {
    throw { status: 401, error: 'That answer is incorrect.' };
  }

  const { passwordHash, passwordSalt } = exports.hashPassword(newPassword);
  await data.updateUser(user.id, { passwordHash, passwordSalt });

  // Log the user straight in — same pattern as post-checkout/beta-signup
  // auto-login, so resetting a password doesn't dead-end at a login form.
  const sessionToken = exports.signToken(user.id);
  return {
    token: sessionToken,
    user: account.serializeUser({ ...user, passwordHash, passwordSalt }),
  };
};

// PUT /api/account/password — logged-in password change. No "current
// password" re-entry required since the session token already proves
// identity; confirmation happens client-side via the retyped field.
exports.handleUpdatePassword = async (userId, body) => {
  const { newPassword } = body;
  if (!newPassword || newPassword.length < 8) {
    throw { status: 400, error: 'Password must be at least 8 characters' };
  }
  const { passwordHash, passwordSalt } = exports.hashPassword(newPassword);
  return account.updatePassword(userId, passwordHash, passwordSalt);
};

// PUT /api/account/security-question — sets/replaces the recovery question
// used by the logged-out reset-with-answer flow.
exports.handleUpdateSecurityQuestion = async (userId, body) => {
  const { question, answer } = body;
  if (!question || !question.trim()) {
    throw { status: 400, error: 'Question required' };
  }
  if (!answer || !normalizeAnswer(answer)) {
    throw { status: 400, error: 'Answer required' };
  }
  const { passwordHash: answerHash, passwordSalt: answerSalt } = exports.hashPassword(normalizeAnswer(answer));
  return account.updateSecurityQuestion(userId, question.trim(), answerHash, answerSalt);
};
