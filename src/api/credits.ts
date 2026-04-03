// =============================================================================
// Credits API Routes
// All credit mutations are server-side only. Admin SDK bypasses Firestore rules.
// The client has read-only access to credits via Firestore onSnapshot.
//
// FREE TIER: 10 lifetime builds. No daily claim. No reset. Ever.
// PAID TIER: monthly credits from subscription, unchanged.
// =============================================================================

import { Hono } from 'hono';
import admin from 'firebase-admin';
import { claimRateLimit, ipInitLimit } from '../utils/rateLimit';
import { getClientIp } from '../middleware/ipGuard';
import { FREE_LIFETIME_LIMIT } from '../services/credits';

const app = new Hono();

// =============================================================================
// POST /api/credits/initialize
// Creates the credits doc for a new user. Idempotent.
// Also enforces per-IP new-account throttle.
// =============================================================================
app.post('/initialize', async (c) => {
  const userId = c.get('userId') as string;

  // Per-IP account creation throttle: 3 new accounts per IP per day
  const ip = getClientIp(c);
  const rl = ipInitLimit(ip);
  if (!rl.allowed) {
    return c.json({ error: 'Too many accounts created from this network today.' }, 429);
  }

  const db = admin.firestore();
  const ref = db.collection('userCredits').doc(userId);

  const snap = await ref.get();
  if (snap.exists) {
    return c.json({ success: true, message: 'Already initialized' });
  }

  await ref.set({
    user_id: userId,
    // Free tier lifetime model
    lifetime_builds_used: 0,
    free_lifetime_limit:  FREE_LIFETIME_LIMIT,
    // Paid tier fields (zero for free users)
    monthly_credits:  0,
    bonus_credits:    0,
    rollover_credits: 0,
    topup_credits:    0,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  return c.json({ success: true, message: 'Credits initialized' });
});

// =============================================================================
// POST /api/credits/claim
// No-op for free users — lifetime credits need no claim.
// Kept for paid users who may have bonus credits.
// =============================================================================
app.post('/claim', async (c) => {
  const userId = c.get('userId') as string;

  const rl = claimRateLimit(userId);
  if (!rl.allowed) {
    return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
  }

  const db = admin.firestore();
  const [creditsSnap, subSnap] = await Promise.all([
    db.collection('userCredits').doc(userId).get(),
    db.collection('subscriptions').doc(userId).get(),
  ]);

  const planType = subSnap.exists ? (subSnap.data()?.plan_type ?? 'free') : 'free';

  // Free users have lifetime credits — nothing to claim
  if (planType === 'free') {
    const d = creditsSnap.exists ? creditsSnap.data()! : {};
    const used  = Number(d.lifetime_builds_used ?? 0);
    const limit = Number(d.free_lifetime_limit  ?? FREE_LIFETIME_LIMIT);
    return c.json({
      success: false,
      lifetime: true,
      lifetime_builds_used: used,
      free_lifetime_limit:  limit,
      remaining: Math.max(0, limit - used),
      message: `Free plan includes ${limit} lifetime builds. You've used ${used}.`,
    });
  }

  // Paid users: nothing to claim on this endpoint currently (bonus credits handled elsewhere)
  return c.json({ success: false, message: 'No claimable credits available.' });
});

// =============================================================================
// GET /api/credits
// Canonical server-side credit balance.
// =============================================================================
app.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const db = admin.firestore();

  const [creditsSnap, subSnap] = await Promise.all([
    db.collection('userCredits').doc(userId).get(),
    db.collection('subscriptions').doc(userId).get(),
  ]);

  if (!creditsSnap.exists) {
    return c.json({ initialized: false, totalCredits: 0, planType: 'free' });
  }

  const d = creditsSnap.data()!;
  const planType = subSnap.exists ? (subSnap.data()?.plan_type ?? 'free') : 'free';
  const isFree   = planType === 'free';

  if (isFree) {
    const used  = Number(d.lifetime_builds_used ?? 0);
    const limit = Number(d.free_lifetime_limit  ?? FREE_LIFETIME_LIMIT);
    const topup = Number(d.topup_credits        ?? 0);
    const totalCredits = Math.max(0, limit - used) + topup;
    return c.json({
      initialized: true,
      totalCredits,
      planType,
      lifetime_builds_used: used,
      free_lifetime_limit:  limit,
      canClaimToday: false, // no daily claim for free tier
    });
  }

  const totalCredits =
    Number(d.monthly_credits  ?? 0) +
    Number(d.bonus_credits    ?? 0) +
    Number(d.rollover_credits ?? 0) +
    Number(d.topup_credits    ?? 0);

  return c.json({ initialized: true, totalCredits, planType, canClaimToday: false });
});

export { app as creditRoutes };
