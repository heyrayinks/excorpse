const https = require('https');

const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
// Resend's shared sandbox sender — fine here since the only email this sends
// is always to the owner's own (Resend account) verified address.
const FROM_ADDRESS = process.env.NOTIFY_FROM_EMAIL || 'Exquisite Corpse <onboarding@resend.dev>';

// Owner notification email — sent on every new account signup, not
// per game-join (that'd be dozens/day and low-signal). Overridable via env
// var so the destination can change without a code edit/redeploy.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'heyrayinks@gmail.com';

// Fire-and-forget, fails safe (logs, never throws) — a broken notification
// must never break the signup it's attached to. No-ops quietly if
// RESEND_API_KEY isn't configured, so the feature degrades gracefully.
// `stats` is optional (data.getStats()) — passed in by the caller rather than
// required here, so this module stays dependency-free and can't deadlock
// against the data layer's write queue.
exports.notifyNewSignup = (user, stats) => {
  if (!RESEND_API_KEY) {
    console.log('[notify] RESEND_API_KEY not set — skipping new-signup email for', user.email);
    return;
  }

  // The running count is the whole point of this email for a solo operator:
  // there's no admin dashboard, so the inbox IS the analytics.
  const tally = stats
    ? `\n\nAccounts: ${stats.total} total`
      + `\nSubscribers: ${stats.subscribed} (${stats.paying} paying, ${stats.comped} comped)`
      + `\nNew: ${stats.last24h} in 24h · ${stats.last7d} in 7d · ${stats.last30d} in 30d`
    : '';

  const payload = JSON.stringify({
    from: FROM_ADDRESS,
    to: NOTIFY_EMAIL,
    subject: stats
      ? `New signup #${stats.total}: ${user.username}`
      : `New Exquisite Corpse signup: ${user.username}`,
    text: `${user.username} (${user.email}) just signed up via ${user.signupMethod}.${tally}`,
  });

  const req = https.request({
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
  }, res => {
    if (res.statusCode >= 400) {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => console.error('[notify] Resend error', res.statusCode, body));
    }
  });
  req.on('error', err => console.error('[notify] Failed to send signup email:', err.message));
  req.write(payload);
  req.end();
};
