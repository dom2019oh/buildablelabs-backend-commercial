// =============================================================================
// Credits API Routes
// All credit mutations are server-side only. Admin SDK bypasses Firestore rules.
// The client has read-only access to credits via Firestore onSnapshot.
// =============================================================================

import { Hono } from 'hono';
import admin from 'firebase-admin';
import { claimRateLimit } from '../utils/rateLimit';

const app = new Hono();
const FREE_DAILY_CREDITS = 3;

function getUTCDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function isClaimedToday(ts: admin.firestore.Timestamp | null | undefined): boolean {
  if (!ts) return false;
  return getUTCDateString(ts.toDate()) === getUTCDateString();
}

function msUntilUTCMidnight(): number {
  const now = new Date();
  const midnight = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
  ));
  return midnight.getTime() - now.getTime();
}

// =============================================================================
// POST /api/credits/initialize
// Creates the credits doc for a new user with safe defaults.
// Idempotent — safe to call multiple times.
// =============================================================================
app.post('/initialize', async (c) => {
  const userId = c.get('userId') as string;
  const db = admin.firestore();
  const ref = db.collection('userCredits').doc(userId);

  const snap = await ref.get();
  if (snap.exists) {
    return c.json({ success: true, message: 'Already initialized' });
  }

  await ref.set({
    user_id: userId,
    monthly_credits: 0,
    bonus_credits: 0,
    rollover_credits: 0,
    topup_credits: 0,
    last_daily_bonus_at: null,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  return c.json({ success: true, message: 'Credits initialized' });
});

// =============================================================================
// POST /api/credits/claim
// Claims the daily 5 credits. Enforced server-side UTC midnight reset.
// Returns 409 if already claimed today.
// =============================================================================
app.post('/claim', async (c) => {
  const userId = c.get('userId') as string;

  // Rate limit: 5 requests per minute (server already enforces once-per-day, this stops hammering)
  const rl = claimRateLimit(userId);
  if (!rl.allowed) {
    return c.json({ error: 'Too many requests', retryAfterMs: rl.retryAfterMs }, 429);
  }

  const db = admin.firestore();
  const creditsRef = db.collection('userCredits').doc(userId);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(creditsRef);

      // Auto-initialize if missing
      if (!snap.exists) {
        tx.set(creditsRef, {
          user_id: userId,
          monthly_credits: 0,
          bonus_credits: FREE_DAILY_CREDITS,
          rollover_credits: 0,
          topup_credits: 0,
          last_daily_bonus_at: admin.firestore.FieldValue.serverTimestamp(),
          created_at: admin.firestore.FieldValue.serverTimestamp(),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        const txRef = db.collection('creditTransactions').doc();
        tx.set(txRef, {
          user_id: userId,
          transaction_type: 'daily_claim',
          action_type: null,
          amount: FREE_DAILY_CREDITS,
          balance_after: FREE_DAILY_CREDITS,
          description: 'Daily credits claimed',
          metadata: {},
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { success: true, credits_added: FREE_DAILY_CREDITS };
      }

      const d = snap.data()!;

      // Server-side UTC date check — cannot be spoofed by client clock
      if (isClaimedToday(d.last_daily_bonus_at ?? null)) {
        return {
          success: false,
          alreadyClaimed: true,
          message: 'Already claimed today',
          ms_until_reset: msUntilUTCMidnight(),
        };
      }

      // SET bonus_credits to exactly FREE_DAILY_CREDITS (not +=)
      // This resets yesterday's unused credits rather than accumulating them.
      tx.update(creditsRef, {
        bonus_credits: FREE_DAILY_CREDITS,
        last_daily_bonus_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      const txRef = db.collection('creditTransactions').doc();
      tx.set(txRef, {
        user_id: userId,
        transaction_type: 'daily_claim',
        action_type: null,
        amount: FREE_DAILY_CREDITS,
        balance_after: FREE_DAILY_CREDITS,
        description: 'Daily credits claimed',
        metadata: {},
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, credits_added: FREE_DAILY_CREDITS };
    });

    if (!result.success) {
      return c.json(result, 409);
    }

    return c.json(result);
  } catch (err) {
    return c.json({ error: 'Failed to claim credits' }, 500);
  }
});

// =============================================================================
// GET /api/credits
// Canonical server-side credit balance. Use this to verify what the UI shows.
// =============================================================================
app.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const db = admin.firestore();

  const [creditsSnap, subSnap] = await Promise.all([
    db.collection('userCredits').doc(userId).get(),
    db.collection('subscriptions').doc(userId).get(),
  ]);

  if (!creditsSnap.exists) {
    return c.json({ initialized: false, totalCredits: 0, canClaimToday: true });
  }

  const d = creditsSnap.data()!;
  const planType: string = subSnap.exists ? (subSnap.data()?.plan_type ?? 'free') : 'free';
  const isFree = planType === 'free';

  const bonusFromToday = isClaimedToday(d.last_daily_bonus_at ?? null);
  const effectiveBonus = bonusFromToday ? Number(d.bonus_credits ?? 0) : 0;

  const totalCredits = isFree
    ? effectiveBonus + Number(d.topup_credits ?? 0)
    : Number(d.monthly_credits ?? 0) + Number(d.bonus_credits ?? 0) +
      Number(d.rollover_credits ?? 0) + Number(d.topup_credits ?? 0);

  return c.json({
    initialized: true,
    totalCredits,
    planType,
    canClaimToday: !bonusFromToday,
    ms_until_reset: msUntilUTCMidnight(),
  });
});

export { app as creditRoutes };
