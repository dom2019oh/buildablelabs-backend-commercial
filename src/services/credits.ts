// =============================================================================
// Credit Service — checks and deducts credits before generation
// Uses Firebase Admin SDK (server-side authority).
// =============================================================================

import admin from 'firebase-admin';

const GENERATION_COST = 1;

function getUTCDateString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function isClaimedToday(lastClaimedAt: admin.firestore.Timestamp | string | null): boolean {
  if (!lastClaimedAt) return false;
  const date = lastClaimedAt instanceof admin.firestore.Timestamp
    ? lastClaimedAt.toDate()
    : new Date(lastClaimedAt as string);
  return getUTCDateString(date) === getUTCDateString();
}

export interface CreditCheckResult {
  success: boolean;
  message: string;
  remainingCredits?: number;
}

/**
 * Atomically checks and deducts 1 credit for a bot generation.
 * For free-plan users, bonus_credits only count if claimed today (UTC).
 * Called by the generate route before starting the AI pipeline.
 */
export async function checkAndDeductCredits(userId: string): Promise<CreditCheckResult> {
  const db = admin.firestore();
  const creditsRef = db.collection('userCredits').doc(userId);
  const subscriptionRef = db.collection('subscriptions').doc(userId);

  return db.runTransaction(async (tx) => {
    const [creditsSnap, subSnap] = await Promise.all([
      tx.get(creditsRef),
      tx.get(subscriptionRef),
    ]);

    const planType = subSnap.exists ? (subSnap.data()?.plan_type ?? 'free') : 'free';

    // Auto-create credits doc if missing
    if (!creditsSnap.exists) {
      tx.set(creditsRef, {
        user_id: userId,
        monthly_credits: 0,
        bonus_credits: 0,
        rollover_credits: 0,
        topup_credits: 0,
        last_daily_bonus_at: null,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      return {
        success: false,
        message: 'No credits available. Claim your 5 daily free credits in the dashboard.',
      };
    }

    const d = creditsSnap.data()!;

    // For free users, bonus_credits expire at UTC midnight if not used.
    const isFree = planType === 'free';
    const bonusCredits = isFree
      ? (isClaimedToday(d.last_daily_bonus_at) ? Number(d.bonus_credits ?? 0) : 0)
      : Number(d.bonus_credits ?? 0);

    const monthly = Number(d.monthly_credits ?? 0);
    const rollover = Number(d.rollover_credits ?? 0);
    const topup = Number(d.topup_credits ?? 0);
    const total = monthly + bonusCredits + rollover + topup;

    if (total < GENERATION_COST) {
      return {
        success: false,
        message: isFree
          ? 'No credits left. Claim your 5 daily free credits or upgrade your plan.'
          : 'Insufficient credits. Please top up or upgrade your plan.',
      };
    }

    // Deduct from bonus first, then monthly
    let toDeduct = GENERATION_COST;
    let newBonus = bonusCredits;
    let newMonthly = monthly;

    if (newBonus >= toDeduct) {
      newBonus -= toDeduct;
      toDeduct = 0;
    } else {
      toDeduct -= newBonus;
      newBonus = 0;
    }
    if (toDeduct > 0) newMonthly = Math.max(0, newMonthly - toDeduct);

    const balanceAfter = newMonthly + newBonus + rollover + topup;

    tx.update(creditsRef, {
      bonus_credits: newBonus,
      monthly_credits: newMonthly,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Log the transaction
    const txLogRef = db.collection('creditTransactions').doc();
    tx.set(txLogRef, {
      user_id: userId,
      transaction_type: 'deduction',
      action_type: 'bot_generation',
      amount: -GENERATION_COST,
      balance_after: balanceAfter,
      description: 'Bot generation',
      metadata: {},
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      message: 'Credits deducted',
      remainingCredits: balanceAfter,
    };
  });
}
