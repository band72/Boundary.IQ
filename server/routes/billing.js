// ─── Billing Route ───────────────────────────────────────────────────────────
// Stripe Checkout + Customer Portal + Webhook handler.
// Set STRIPE_SECRET_KEY in .env to enable live Stripe.
// Without it, the route operates in "mock mode" — admin can grant plans manually.

import { Router } from 'express';
import { createRequire } from 'module';
import { requireAuth } from '../middleware/auth.js';
import {
  upsertSubscription,
  getSubscriptionByUser,
  getSubscriptionByStripeCustomer,
  getSubscriptionByStripeSubscription,
  updateUserPlan,
  getUserById,
} from '../services/diagnosticsDb.js';

const require = createRequire(import.meta.url);
const router = Router();

// ── Lazy Stripe client ────────────────────────────────────────────────────────
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const Stripe = require('stripe');
    _stripe = new Stripe(key, { apiVersion: '2024-11-20.acacia' });
    return _stripe;
  } catch {
    return null;
  }
}

const isMockMode = () => !process.env.STRIPE_SECRET_KEY;

// Plan config
const PLANS = {
  basic: {
    name: 'Basic',
    priceId: process.env.STRIPE_BASIC_PRICE_ID || null,
    price: 500, // cents
    interval: 'month',
    features: ['50 deed solves/day', 'Traverse Compute (full)', 'Legal Writer (pro)', 'Batch Deed processing (basic)'],
  },
  pro: {
    name: 'Pro',
    priceId: process.env.STRIPE_PRO_PRICE_ID || null,
    price: 1999, // cents
    interval: 'month',
    features: ['Unlimited deed solves', 'Full Batch Deed processing', 'Plat Extraction with AI', 'Full Analytics Dashboard', 'Priority support'],
  },
  enterprise: {
    name: 'Enterprise',
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || null,
    price: 9900,
    interval: 'month',
    features: ['Everything in Pro', '5 team members', 'Custom AI model configuration', 'Full REST API access', 'Dedicated SLA support'],
  },
};

// GET /api/billing/plans — public, returns plan info
router.get('/plans', (req, res) => {
  res.json({
    mockMode: isMockMode(),
    plans: Object.entries(PLANS).map(([id, p]) => ({
      id,
      name: p.name,
      price: p.price,
      interval: p.interval,
      features: p.features,
      priceId: p.priceId,
    })),
    freePlan: {
      id: 'free',
      name: 'Free',
      price: 0,
      features: ['5 deed solves/day', 'Traverse Compute', 'Legal Writer', 'Basic Dashboard'],
    },
  });
});

// GET /api/billing/status — authenticated, returns current user's subscription
router.get('/status', requireAuth, (req, res) => {
  try {
    const sub = getSubscriptionByUser(req.user.id);
    const user = getUserById(req.user.id);
    res.json({
      plan: user?.plan || 'free',
      role: req.user.role,
      subscription: sub ? {
        status: sub.Status,
        periodEnd: sub.PeriodEnd,
        stripeCustomerId: sub.StripeCustomerId,
        stripeSubscriptionId: sub.StripeSubscriptionId,
      } : null,
      mockMode: isMockMode(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/create-checkout — create Stripe Checkout session
router.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    const { plan = 'pro' } = req.body;

    if (isMockMode()) {
      // Mock mode: immediately upgrade the user
      updateUserPlan(req.user.id, plan);
      return res.json({
        mockMode: true,
        success: true,
        message: `Plan upgraded to "${plan}" (mock mode — no real payment processed).`,
        plan,
      });
    }

    const stripe = getStripe();
    const planConfig = PLANS[plan];
    if (!planConfig?.priceId) {
      return res.status(400).json({ error: `Plan "${plan}" is not configured with a Stripe price ID.` });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5174';
    const user = getUserById(req.user.id);

    // Reuse existing Stripe customer if available
    const existingSub = getSubscriptionByUser(req.user.id);
    let customerParams = {};
    if (existingSub?.StripeCustomerId) {
      customerParams = { customer: existingSub.StripeCustomerId };
      // Make sure the customer email is updated to match username
      if (req.user.username.includes('@')) {
        try {
          await stripe.customers.update(existingSub.StripeCustomerId, {
            email: req.user.username,
          });
        } catch (err) {
          console.warn(`Failed to update Stripe customer email: ${err.message}`);
        }
      }
    } else {
      customerParams = {
        customer_email: req.user.username.includes('@') ? req.user.username : undefined,
        metadata: { userId: String(req.user.id), username: req.user.username },
      };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: planConfig.priceId, quantity: 1 }],
      ...customerParams,
      success_url: `${frontendUrl}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/?billing=cancelled`,
      metadata: { userId: String(req.user.id), plan },
      subscription_data: {
        metadata: { userId: String(req.user.id), plan },
      },
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/portal — create Stripe Customer Portal session
router.post('/portal', requireAuth, async (req, res) => {
  try {
    if (isMockMode()) {
      return res.json({ mockMode: true, message: 'Billing portal not available in mock mode. Use Admin Panel to manage subscriptions.' });
    }

    const stripe = getStripe();
    const sub = getSubscriptionByUser(req.user.id);

    if (!sub?.StripeCustomerId) {
      return res.status(404).json({ error: 'No Stripe customer found. Please upgrade first.' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5174';
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.StripeCustomerId,
      return_url: `${frontendUrl}/?billing=portal_return`,
    });

    res.json({ portalUrl: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/webhook — Stripe webhook (raw body required)
router.post('/webhook', async (req, res) => {
  if (isMockMode()) return res.json({ received: true });

  const stripe = getStripe();
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[Billing] CRITICAL error: STRIPE_WEBHOOK_SECRET is not configured in production. Aborting webhook request.');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    console.warn('[Billing] STRIPE_WEBHOOK_SECRET not set — webhook verification skipped.');
    return res.status(200).json({ received: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = parseInt(session.metadata?.userId);
        const plan = session.metadata?.plan || 'pro';
        if (userId) {
          upsertSubscription(userId, {
            plan,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            status: 'active',
            periodEnd: null, // will be updated by subscription.updated
          });
          updateUserPlan(userId, plan);
          console.log(`✓ [Billing] Subscription activated: userId=${userId} plan=${plan}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const existing = getSubscriptionByStripeSubscription(sub.id);
        if (existing) {
          const plan = sub.metadata?.plan || existing.Plan || 'pro';
          const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
          upsertSubscription(existing.userId, {
            plan,
            stripeSubscriptionId: sub.id,
            status: sub.status,
            periodEnd,
          });
          if (sub.status === 'active') {
            updateUserPlan(existing.userId, plan);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const existing = getSubscriptionByStripeSubscription(sub.id);
        if (existing) {
          upsertSubscription(existing.userId, {
            plan: 'free',
            stripeSubscriptionId: sub.id,
            status: 'cancelled',
            periodEnd: null,
          });
          updateUserPlan(existing.userId, 'free');
          console.log(`⚠ [Billing] Subscription cancelled: userId=${existing.userId}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const existing = getSubscriptionByStripeCustomer(invoice.customer);
        if (existing) {
          console.warn(`⚠ [Billing] Payment failed for userId=${existing.UserId}`);
        }
        break;
      }
    }
  } catch (err) {
    console.error('[Billing] Webhook handler error:', err.message);
  }

  res.json({ received: true });
});

export default router;
