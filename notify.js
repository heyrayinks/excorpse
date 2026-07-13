const https = require('https');

// Owner notification email — sent on every new paid/beta account signup, not
// per game-join (that'd be dozens/day and low-signal). Overridable via env
// var so the destination can change without a code edit/redeploy.
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'heyrayinks@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
// Resend's shared sandbox sender — works without verifying a custom domain
// as long as the destination is the Resend account's own verified address.
const FROM_ADDRESS = process.env.NOTIFY_FROM_EMAIL || 'Exquisite Corpse <onboarding@resend.dev>';

// Fire-and-forget: a notification failure must never break a real signup.
// No-ops quietly (just logs) if RESEND_API_KEY isn't configured yet, so the
// feature degrades gracefully rather than crashing anything.
exports.notifyNewSignup = (user) => {
  if (!RESEND_API_KEY) {
    console.log('[notify] RESEND_API_KEY not set — skipping new-signup email for', user.email);
    return;
  }

  const payload = JSON.stringify({
    from: FROM_ADDRESS,
    to: NOTIFY_EMAIL,
    subject: `New Exquisite Corpse signup: ${user.username}`,
    text: `${user.username} (${user.email}) just signed up via ${user.signupMethod}.\n\nTotal signups tracked separately — check the account list if you want a running count.`,
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
