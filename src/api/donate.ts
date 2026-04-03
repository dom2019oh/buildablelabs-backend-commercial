// =============================================================================
// Donate API — POST /api/donate
// Unauthenticated — anyone can donate.
// Creates a Stripe Checkout Session (one-time payment) for a custom amount.
// =============================================================================

import { Hono } from 'hono';
import Stripe from 'stripe';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
  if (!_stripe) _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2025-01-27.acacia' });
  return _stripe;
}

const app = new Hono();

// POST /api/donate
// Body: { amount: number (USD dollars), name?: string, message?: string }
app.post('/', async (c) => {
  if (!env.STRIPE_SECRET_KEY) {
    return c.json({ error: 'Payments are not yet configured.' }, 503);
  }

  const body = await c.req.json().catch(() => ({}));
  const rawAmount = Number(body.amount);
  const name    = String(body.name    ?? '').trim().slice(0, 80);
  const message = String(body.message ?? '').trim().slice(0, 200);

  if (!rawAmount || rawAmount < 1 || rawAmount > 10_000) {
    return c.json({ error: 'Amount must be between $1 and $10,000.' }, 400);
  }

  const amountCents = Math.round(rawAmount * 100);
  const stripe = getStripe();

  const productDescription = [
    name    ? `From: ${name}` : null,
    message ? `"${message}"` : null,
  ].filter(Boolean).join(' — ') || undefined;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      submit_type: 'donate',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Donation to Buildable Labs',
              description: productDescription,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      success_url: 'https://buildablelabs.dev/donate?success=true',
      cancel_url:  'https://buildablelabs.dev/donate',
      metadata: {
        type: 'donation',
        donor_name: name || 'Anonymous',
        donor_message: message,
        amount_dollars: String(rawAmount),
      },
    });

    return c.json({ url: session.url });
  } catch (err: any) {
    logger.error({ err }, 'Stripe donate session error');
    return c.json({ error: err.message ?? 'Failed to create checkout session.' }, 500);
  }
});

export { app as donateRoutes };
