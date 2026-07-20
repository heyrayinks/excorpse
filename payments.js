const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const auth = require('./auth');
const data = require('./data');
const account = require('./account');
const notify = require('./notify');

// Stored as an env var (not a source-code literal) since this repo is public —
// hardcoding it here would make it visible to anyone browsing GitHub.
const BETA_CODE = process.env.BETA_CODE || null;

// Code an ALREADY-logged-in member can redeem from the account page to gain
// subscriber status without Stripe. Defaults to the same BETA_CODE used at
// signup, but a distinct ACCESS_CODE can be set to hand existing members a
// different code from the one that also creates beta accounts. Env-only,
// same reasoning as BETA_CODE.
const ACCESS_CODE = process.env.ACCESS_CODE || BETA_CODE;

// Validation for signup request
exports.validateSignupRequest = (body) => {
  const { email, username, password } = body;
  const errors = [];

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('Valid email required');
  }
  if (!username || username.length < 3 || username.length > 30) {
    errors.push('Username must be 3-30 characters');
  }
  if (!password || password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }

  // Check for existing user (email or username already taken)
  if (data.getUserByEmail(email)) {
    errors.push('Email already registered');
  }
  if (data.getUserByUsername(username)) {
    errors.push('Username already taken');
  }

  return errors.length > 0 ? errors : null;
};

// POST /api/auth/signup — free, instant account creation. No payment
// involved at all; every account starts unsubscribed and can subscribe
// later (or never) from the account page.
exports.handleFreeSignup = async (body) => {
  const { email, username, password } = body;
  const errors = exports.validateSignupRequest({ email, username, password });
  if (errors) {
    throw { status: 400, error: errors[0] };
  }

  const { passwordHash, passwordSalt } = auth.hashPassword(password);
  const user = await data.createUser(email, username, passwordHash, passwordSalt, 'free', false);
  notify.notifyNewSignup(user);

  const token = auth.signToken(user.id);
  return { token, user: account.serializeUser(user) };
};

// Beta signup: creates a free account directly AND grants free subscriber
// status, bypassing Stripe entirely, when a valid BETA_CODE is supplied.
// Auto-logs in on success, same shape as /api/auth/login. Accounts no
// longer need bypassing (they're free either way) — this is now purely a
// way to gift/test subscriber access without a real charge.
exports.handleBetaSignup = async (body) => {
  const { email, username, password, betaCode } = body;

  if (!BETA_CODE) {
    throw { status: 403, error: 'Beta signup is not enabled' };
  }
  if (!betaCode || betaCode.trim().toLowerCase() !== BETA_CODE.toLowerCase()) {
    throw { status: 403, error: 'Invalid beta code' };
  }

  const errors = exports.validateSignupRequest({ email, username, password });
  if (errors) {
    throw { status: 400, error: errors[0] };
  }

  const { passwordHash, passwordSalt } = auth.hashPassword(password);
  const user = await data.createUser(email, username, passwordHash, passwordSalt, 'beta-subscriber', true);
  notify.notifyNewSignup(user);

  const token = auth.signToken(user.id);
  return { token, user: account.serializeUser(user) };
};

// POST /api/account/redeem-code (auth required) — an already-logged-in
// member redeeming an access code to unlock the subscriber brushes without
// Stripe. A comp grant, same runtime shape as a beta-subscriber: subscribed
// with no Stripe linkage, so no webhook ever downgrades it (intended — it's
// a gift, not a paid subscription). Works even while SUBSCRIPTIONS_ENABLED
// is off, which is the point: it lets brushes be comped before Stripe is set up.
exports.redeemAccessCode = async (userId, code) => {
  if (!ACCESS_CODE) {
    throw { status: 403, error: 'Access codes are not enabled' };
  }
  const user = data.getUserById(userId);
  if (!user) {
    throw { status: 404, error: 'User not found' };
  }
  if (user.subscribed) {
    // No-op guard: don't clobber an existing (possibly Stripe-backed)
    // subscription, and give a clear message instead of silently "succeeding".
    throw { status: 400, error: "You already have the brushes unlocked" };
  }
  if (!code || code.trim().toLowerCase() !== ACCESS_CODE.toLowerCase()) {
    throw { status: 403, error: 'Invalid access code' };
  }
  const updated = await data.updateUser(userId, {
    subscribed: true,
    subscriptionStatus: 'active',
  });
  return account.serializeUser(updated);
};

// POST /api/stripe/checkout (auth required) — an already-logged-in, free
// account subscribing to the monthly brush unlock. Unlike the old one-time
// flow, the account already exists here; this only ever starts/re-starts a
// subscription for it, never creates one.
exports.createSubscriptionCheckoutSession = async (user) => {
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: user.stripeCustomerId || undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email,
      line_items: [
        {
          price: process.env.STRIPE_SUBSCRIPTION_PRICE_ID,
          quantity: 1,
        },
      ],
      // Metadata on both the Session and the Subscription itself — webhook
      // events for subscription updates/cancellation reference the
      // subscription/customer, not the checkout session that created it.
      metadata: { userId: user.id },
      subscription_data: { metadata: { userId: user.id } },
      success_url: `${appUrl}/?subscribe=success`,
      cancel_url: `${appUrl}/?subscribe=cancelled`,
    });

    return session;
  } catch (err) {
    console.error('Stripe error:', err);
    throw { status: 500, error: 'Failed to create checkout session' };
  }
};

// POST /api/stripe/portal (auth required) — Stripe-hosted page for a
// subscriber to update their card or cancel, so there's no custom
// billing-management UI to build here.
exports.createPortalSession = async (user) => {
  if (!user.stripeCustomerId) {
    throw { status: 400, error: 'No subscription to manage yet' };
  }
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${appUrl}/?account`,
    });
    return session;
  } catch (err) {
    console.error('Stripe error:', err);
    throw { status: 500, error: 'Failed to open billing portal' };
  }
};

// checkout.session.completed — a subscribe checkout just completed. Finds
// the account via the metadata attached at session-creation time (the
// account already exists; this only ever activates a subscription on it).
async function handleSubscriptionCheckoutComplete(event) {
  const session = event.data.object;
  const userId = session.metadata && session.metadata.userId;
  if (!userId) {
    console.error('checkout.session.completed with no userId metadata:', session.id);
    return;
  }

  const user = data.getUserById(userId);
  if (!user) {
    console.error('checkout.session.completed for unknown user:', userId);
    return;
  }

  await data.updateUser(userId, {
    stripeCustomerId: session.customer,
    stripeSubscriptionId: session.subscription,
    subscribed: true,
    subscriptionStatus: 'active',
  });
  console.log('Subscription activated for user:', userId);
}

// customer.subscription.updated — fires on renewals, plan changes, and
// status transitions (e.g. active -> past_due after a failed charge).
async function handleSubscriptionUpdated(event) {
  const subscription = event.data.object;
  const userId = subscription.metadata && subscription.metadata.userId;
  const user = userId ? data.getUserById(userId) : data.getUserByStripeCustomerId(subscription.customer);
  if (!user) {
    console.error('customer.subscription.updated for unknown user, customer:', subscription.customer);
    return;
  }

  const subscribed = subscription.status === 'active' || subscription.status === 'trialing';
  await data.updateUser(user.id, {
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    subscribed,
  });
}

// customer.subscription.deleted — cancellation (immediate, or the period
// finally ending after a Portal-initiated cancel-at-period-end). Access
// reverts to the free brush set.
async function handleSubscriptionDeleted(event) {
  const subscription = event.data.object;
  const userId = subscription.metadata && subscription.metadata.userId;
  const user = userId ? data.getUserById(userId) : data.getUserByStripeCustomerId(subscription.customer);
  if (!user) {
    console.error('customer.subscription.deleted for unknown user, customer:', subscription.customer);
    return;
  }

  await data.updateUser(user.id, {
    subscribed: false,
    subscriptionStatus: 'canceled',
  });
}

// Webhook endpoint handler (requires raw body for signature verification)
exports.handleWebhook = async (rawBody, signature) => {
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET not set');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    throw { status: 400, error: 'Invalid signature' };
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleSubscriptionCheckoutComplete(event);
    } else if (event.type === 'customer.subscription.updated') {
      await handleSubscriptionUpdated(event);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event);
    }
    // invoice.payment_failed isn't separately handled — Stripe already
    // retries failed renewals automatically and fires
    // customer.subscription.updated (status -> past_due, then eventually
    // .deleted if retries exhaust), which the handlers above already cover.
  } catch (err) {
    console.error('Error processing webhook event:', event.type, err);
    // Still return 200 to avoid Stripe retry storms — Stripe will retry if
    // we return 5xx, and a transient failure here shouldn't jam the queue.
  }

  return { received: true };
};
