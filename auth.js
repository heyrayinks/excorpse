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

// Login endpoint logic — accepts either email or username as the identifier,
// since that's what most people expect and mistyping one for the other
// (or browser autofill mixing them up) shouldn't produce a confusing failure.
exports.handleLogin = async (body) => {
  const { email, password } = body;
  if (!email || !password) {
    throw { status: 400, error: 'Email and password required' };
  }

  const user = data.getUserByEmail(email) || data.getUserByUsername(email);
  if (!user) {
    throw { status: 401, error: 'Invalid credentials' };
  }

  if (!user.paid) {
    throw { status: 403, error: 'Account not yet activated (payment pending)' };
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
