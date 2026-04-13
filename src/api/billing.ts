// =============================================================================
// Billing API Routes — Stripe integration
// POST /api/billing/checkout  → create Stripe Checkout session
// POST /api/billing/portal    → create Stripe Billing Portal session
// POST /api/billing/webhook   → Stripe webhook (UNAUTHENTICATED — mounted separately)
// =============================================================================

import { Hono } from 'hono';
import Stripe from 'stripe';
import admin from 'firebase-admin';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// =============================================================================
// Stripe client (lazy — only initialised if key is present)
// =============================================================================
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
  if (!_stripe) _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2025-01-27.acacia' });
  return _stripe;
}

// =============================================================================
// Credit tier → Stripe Price ID mapping
// These Price IDs are created once in the Stripe dashboard and stored as env vars.
// Format:  STRIPE_PRICE_PRO_T1 ... STRIPE_PRICE_PRO_T10
//          STRIPE_PRICE_MAX_T1 ... STRIPE_PRICE_MAX_T10
// If a Price ID is not set, checkout will fail with a clear error.
// =============================================================================
// Valid tier IDs — exhaustive allowlist, prevents env-var probing
const VALID_TIER_IDS = new Set([
  'pro-t1','pro-t2','pro-t3','pro-t4','pro-t5','pro-t6','pro-t7','pro-t8','pro-t9','pro-t10',
  'pro-t1-annual','pro-t2-annual','pro-t3-annual','pro-t4-annual','pro-t5-annual',
  'pro-t6-annual','pro-t7-annual','pro-t8-annual','pro-t9-annual','pro-t10-annual',
  'max-t1','max-t2','max-t3','max-t4','max-t5','max-t6','max-t7','max-t8','max-t9','max-t10',
  'max-t1-annual','max-t2-annual','max-t3-annual','max-t4-annual','max-t5-annual',
  'max-t6-annual','max-t7-annual','max-t8-annual','max-t9-annual','max-t10-annual',
]);

function getPriceId(tierId: string): string | null {
  if (!VALID_TIER_IDS.has(tierId)) return null;
  const key = `STRIPE_PRICE_${tierId.toUpperCase().replace(/-/g, '_')}`;
  return (process.env[key] ?? null);
}

// =============================================================================
// Helpers
// =============================================================================
async function getOrCreateCustomer(stripe: Stripe, userId: string, email: string): Promise<string> {
  const db = admin.firestore();
  const subRef = db.collection('subscriptions').doc(userId);
  const snap = await subRef.get();

  if (snap.exists && snap.data()?.stripe_customer_id) {
    return snap.data()!.stripe_customer_id as string;
  }

  // Create new Stripe customer
  const customer = await stripe.customers.create({
    email,
    metadata: { firebase_uid: userId },
  });

  // Store customer ID via Admin SDK (bypasses Firestore rules)
  await subRef.set({
    stripe_customer_id: customer.id,
    plan_type: 'free',
    status: 'active',
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return customer.id;
}

// =============================================================================
// Authenticated routes
// =============================================================================
const app = new Hono();

// POST /api/billing/checkout
app.post('/checkout', async (c) => {
  const stripe = getStripe().valueOf ? getStripe() : null;
  if (!stripe) return c.json({ error: 'Billing not configured' }, 503);

  const userId = c.get('userId') as string;
  const user = c.get('user') as admin.auth.DecodedIdToken;

  const body = await c.req.json().catch(() => ({}));
  const tierId: string = body.priceId ?? ''; // frontend sends tier id like "pro-t1"

  if (!tierId) return c.json({ error: 'priceId is required' }, 400);

  // Check for existing active subscription — send to portal instead
  const db = admin.firestore();
  const subSnap = await db.collection('subscriptions').doc(userId).get();
  if (subSnap.exists) {
    const sub = subSnap.data()!;
    if (sub.stripe_subscription_id && sub.status === 'active' && sub.plan_type !== 'free') {
      return c.json({ shouldUsePortal: true });
    }
  }

  const stripePriceId = getPriceId(tierId);
  if (!stripePriceId) {
    return c.json({
      error: `No Stripe Price ID configured for tier "${tierId}". Set env var STRIPE_PRICE_${tierId.toUpperCase().replace('-', '_')}.`,
    }, 400);
  }

  try {
    const customerId = await getOrCreateCustomer(stripe, userId, user.email ?? '');
    const redirectBase = env.STRIPE_REDIRECT_BASE;

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      client_reference_id: userId,
      mode: 'subscription',
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: `${redirectBase}/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${redirectBase}/dashboard/billing?checkout=canceled`,
      metadata: { firebase_uid: userId, tier_id: tierId },
      subscription_data: { metadata: { firebase_uid: userId, tier_id: tierId } },
      allow_promotion_codes: true,
      custom_text: {
        terms_of_service_acceptance: {
          message: 'Credits are non-refundable and non-transferable once issued. By subscribing you agree to the Buildable Labs Terms of Service.',
        },
      },
      consent_collection: { terms_of_service: 'required' },
    });

    return c.json({ url: session.url });
  } catch (err: any) {
    logger.error({ err, userId }, 'Stripe checkout error');
    return c.json({ error: err.message ?? 'Failed to create checkout session' }, 500);
  }
});

// POST /api/billing/portal
app.post('/portal', async (c) => {
  const stripe = getStripe();
  const userId = c.get('userId') as string;

  const db = admin.firestore();
  const subSnap = await db.collection('subscriptions').doc(userId).get();

  if (!subSnap.exists || !subSnap.data()?.stripe_customer_id) {
    return c.json({ noSubscription: true });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: subSnap.data()!.stripe_customer_id,
      return_url: `${env.STRIPE_REDIRECT_BASE}/dashboard/billing`,
    });
    return c.json({ url: session.url });
  } catch (err: any) {
    logger.error({ err, userId }, 'Stripe portal error');
    return c.json({ error: err.message ?? 'Failed to open billing portal' }, 500);
  }
});

export { app as billingRoutes };

// =============================================================================
// Webhook handler (separate Hono app — mounted BEFORE auth middleware)
// =============================================================================
const webhookApp = new Hono();

webhookApp.post('/', async (c) => {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: 'Billing not configured' }, 503);
  }

  const stripe = getStripe();
  const sig = c.req.header('stripe-signature');
  if (!sig) return c.json({ error: 'Missing signature' }, 400);

  const rawBody = await c.req.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    logger.warn({ err }, 'Stripe webhook signature verification failed');
    return c.json({ error: 'Webhook signature verification failed' }, 400);
  }

  const db = admin.firestore();

  try {
    switch (event.type) {
      // ── Checkout completed ──────────────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id ?? session.metadata?.firebase_uid;
        if (!userId) { logger.warn({ session }, 'checkout.session.completed: no user id'); break; }

        const tierId: string = session.metadata?.tier_id ?? '';
        const credits = parseCreditCount(tierId);
        const planType = tierId.startsWith('max') ? 'max' : 'pro';

        const subRef = db.collection('subscriptions').doc(userId);
        await subRef.set({
          plan_type: planType,
          status: 'active',
          stripe_customer_id: session.customer as string,
          stripe_subscription_id: session.subscription as string,
          selected_credits: credits,
          tier_id: tierId,
          current_period_start: null,
          current_period_end: null,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        // Provision monthly credits immediately
        await db.collection('userCredits').doc(userId).set({
          monthly_credits: credits,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        logger.info({ userId, planType, credits }, 'Subscription provisioned');
        break;
      }

      // ── Subscription updated ────────────────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.firebase_uid;
        if (!userId) break;

        const tierId = sub.metadata?.tier_id ?? '';
        const credits = parseCreditCount(tierId);
        const planType = tierId.startsWith('max') ? 'max' : 'pro';
        const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : 'canceled';

        await db.collection('subscriptions').doc(userId).set({
          plan_type: status === 'active' ? planType : 'free',
          status,
          selected_credits: credits,
          tier_id: tierId,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        if (status === 'active') {
          await db.collection('userCredits').doc(userId).set({
            monthly_credits: credits,
            updated_at: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        break;
      }

      // ── Subscription cancelled ──────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.firebase_uid;
        if (!userId) break;

        await db.collection('subscriptions').doc(userId).set({
          plan_type: 'free',
          status: 'canceled',
          stripe_subscription_id: null,
          selected_credits: 0,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        // Zero out monthly credits; free daily credits still work
        await db.collection('userCredits').doc(userId).set({
          monthly_credits: 0,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        logger.info({ userId }, 'Subscription cancelled — downgraded to free');
        break;
      }

      // ── Invoice paid → refresh monthly credits on renewal ──────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.billing_reason !== 'subscription_cycle') break;

        const customerId = invoice.customer as string;
        // Look up userId by customer ID
        const subSnap = await db.collection('subscriptions')
          .where('stripe_customer_id', '==', customerId).limit(1).get();

        if (subSnap.empty) break;
        const subDoc = subSnap.docs[0];
        const userId = subDoc.id;
        const credits = (subDoc.data().selected_credits as number) ?? 0;

        await db.collection('userCredits').doc(userId).set({
          monthly_credits: credits,
          rollover_credits: 0, // reset rollover each cycle (simplification)
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        logger.info({ userId, credits }, 'Monthly credits refreshed on renewal');
        break;
      }

      default:
        break;
    }
  } catch (err) {
    logger.error({ err, eventType: event.type }, 'Webhook handler error');
    return c.json({ error: 'Webhook processing failed' }, 500);
  }

  return c.json({ received: true });
});

export { webhookApp as billingWebhookRoutes };

// =============================================================================
// Helper: extract credit count from tier id ("pro-t3" → 90, "max-t2" → 200)
// Matches the CREDIT_TIERS in useSubscriptionPlans.ts
// =============================================================================
function parseCreditCount(tierId: string): number {
  const m = tierId.match(/^(pro|max)-t(\d+)$/);
  if (!m) return 0;
  const tier = parseInt(m[2], 10);
  if (m[1] === 'pro') return tier * 30;
  if (m[1] === 'max') return tier * 100;
  return 0;
}
