// =============================================================================
// Credit Service — action-based credit deduction with plan-model routing
// Uses Firebase Admin SDK (server-side authority).
// =============================================================================

import admin from 'firebase-admin';

// =============================================================================
// TYPES
// =============================================================================

export type ActionType =
  | 'full_build'
  | 'edit_iterate'
  | 'plan_mode'
  | 'architect_mode'
  | 'mermaid_diagram'
  | 'file_repair'
  | 'validate_review'
  | 'clarify'
  | 'chat';

// Credit cost per action (0 = free, no deduction)
const ACTION_COSTS: Record<ActionType, number> = {
  full_build:      2,
  edit_iterate:    1,
  plan_mode:       1,
  architect_mode:  1,
  mermaid_diagram: 1,
  file_repair:     1,
  validate_review: 1,
  clarify:         0,
  chat:            0,
};

// Model to use per plan — Haiku for free/lite (7× cheaper), Sonnet for pro/max
const PLAN_MODEL: Record<string, string> = {
  free: 'claude-haiku-4-5-20251001',
  lite: 'claude-haiku-4-5-20251001',
  pro:  'claude-sonnet-4-6',
  max:  'claude-sonnet-4-6',
};

// =============================================================================
// HELPERS
// =============================================================================

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

// =============================================================================
// TYPES
// =============================================================================

export interface CreditCheckResult {
  success: boolean;
  message: string;
  remainingCredits?: number;
  model?: string;
  planType?: string;
}

// =============================================================================
// checkAndDeductCredits
// Atomically checks, deducts credits, and returns the model to use.
// Called by the generate route before starting the AI pipeline.
// =============================================================================

export async function checkAndDeductCredits(
  userId: string,
  actionType: ActionType = 'full_build',
): Promise<CreditCheckResult> {
  const db = admin.firestore();
  const creditsRef = db.collection('userCredits').doc(userId);
  const subscriptionRef = db.collection('subscriptions').doc(userId);
  const cost = ACTION_COSTS[actionType];

  return db.runTransaction(async (tx) => {
    const [creditsSnap, subSnap] = await Promise.all([
      tx.get(creditsRef),
      tx.get(subscriptionRef),
    ]);

    const planType = subSnap.exists ? (subSnap.data()?.plan_type ?? 'free') : 'free';
    const model = PLAN_MODEL[planType] ?? PLAN_MODEL['free'];

    // Free actions (clarify, chat) — skip deduction entirely
    if (cost === 0) {
      return {
        success: true,
        message: 'No credits required',
        remainingCredits: undefined,
        model,
        planType,
      };
    }

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
        message: 'No credits available. Claim your 3 daily free credits in the dashboard.',
        model,
        planType,
      };
    }

    const d = creditsSnap.data()!;
    const isFree = planType === 'free';

    // For free users, bonus_credits expire at UTC midnight if not claimed today
    const bonusCredits = isFree
      ? (isClaimedToday(d.last_daily_bonus_at) ? Number(d.bonus_credits ?? 0) : 0)
      : Number(d.bonus_credits ?? 0);

    const monthly  = Number(d.monthly_credits  ?? 0);
    const rollover = Number(d.rollover_credits  ?? 0);
    const topup    = Number(d.topup_credits     ?? 0);
    const total    = monthly + bonusCredits + rollover + topup;

    if (total < cost) {
      return {
        success: false,
        message: isFree
          ? `Need ${cost} credit${cost !== 1 ? 's' : ''} (you have ${total}). Claim your daily credits or upgrade.`
          : `Need ${cost} credit${cost !== 1 ? 's' : ''} (you have ${total}). Top up or upgrade your plan.`,
        model,
        planType,
      };
    }

    // Deduct in order: bonus → monthly → rollover → topup
    let toDeduct   = cost;
    let newBonus   = bonusCredits;
    let newMonthly = monthly;
    let newRollover = rollover;
    let newTopup   = topup;

    if (newBonus >= toDeduct) {
      newBonus -= toDeduct;
      toDeduct = 0;
    } else {
      toDeduct -= newBonus;
      newBonus = 0;
    }
    if (toDeduct > 0) {
      if (newMonthly >= toDeduct) {
        newMonthly -= toDeduct;
        toDeduct = 0;
      } else {
        toDeduct -= newMonthly;
        newMonthly = 0;
      }
    }
    if (toDeduct > 0) {
      if (newRollover >= toDeduct) {
        newRollover -= toDeduct;
        toDeduct = 0;
      } else {
        toDeduct -= newRollover;
        newRollover = 0;
      }
    }
    if (toDeduct > 0) {
      newTopup = Math.max(0, newTopup - toDeduct);
    }

    const balanceAfter = newMonthly + newBonus + newRollover + newTopup;

    tx.update(creditsRef, {
      bonus_credits:    newBonus,
      monthly_credits:  newMonthly,
      rollover_credits: newRollover,
      topup_credits:    newTopup,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    const txLogRef = db.collection('creditTransactions').doc();
    tx.set(txLogRef, {
      user_id: userId,
      transaction_type: 'deduction',
      action_type: actionType,
      amount: -cost,
      balance_after: balanceAfter,
      description: `${actionType.replace(/_/g, ' ')} (${cost} credit${cost !== 1 ? 's' : ''})`,
      metadata: { planType, model },
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      message: 'Credits deducted',
      remainingCredits: balanceAfter,
      model,
      planType,
    };
  });
}
