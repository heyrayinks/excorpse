const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const auth = require('./auth');
const data = require('./data');

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

// Create Stripe Checkout Session for signup
exports.createCheckoutSession = async (email, username, password) => {
  const errors = exports.validateSignupRequest({ email, username, password });
  if (errors) {
    throw { status: 400, error: errors[0] }; // Return first error
  }

  // Hash password server-side (never send raw password to Stripe)
  const { passwordHash, passwordSalt } = auth.hashPassword(password);

  // Metadata fields: these are passed back in the webhook
  // Stripe metadata has a 500-char limit per value, so keep it minimal
  const metadata = {
    email,
    username,
    passwordHash,
    passwordSalt,
  };

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${process.env.APP_URL || 'http://localhost:3000'}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/?checkout=cancelled`,
      metadata,
    });

    return session;
  } catch (err) {
    console.error('Stripe error:', err);
    throw { status: 500, error: 'Failed to create checkout session' };
  }
};

// Handle Stripe webhook: checkout.session.completed
exports.handleCheckoutComplete = async (event) => {
  const session = event.data.object;

  // Re-validate signup data from metadata (defensive check)
  const { email, username, passwordHash, passwordSalt } = session.metadata;
  if (!email || !username || !passwordHash || !passwordSalt) {
    console.error('Invalid metadata in webhook:', session.id);
    throw new Error('Missing signup metadata');
  }

  // Check for race condition (user already created)
  if (data.getUserByEmail(email)) {
    console.log('User already exists for email:', email);
    return;
  }

  // Create the user with paid: true
  const user = await data.createUser(email, username, passwordHash, passwordSalt, session.customer, session.id);
  console.log('User created via webhook:', user.id, email);

  return user;
};

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

  // Handle checkout completion
  if (event.type === 'checkout.session.completed') {
    try {
      await exports.handleCheckoutComplete(event);
    } catch (err) {
      console.error('Error processing checkout completion:', err);
      // Still return 200 to avoid Stripe retry storms
      // Stripe will retry if we return 5xx
    }
  }

  // For other event types, just acknowledge (200)
  return { received: true };
};
