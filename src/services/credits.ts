// =============================================================================
// Credit Service — action-based credit deduction with plan-model routing
// Uses Firebase Admin SDK (server-side authority).
//
// FREE TIER: 10 lifetime builds total. No daily reset. No claim needed.
// PAID TIER: monthly_credits from subscription, unchanged.
// =============================================================================

import admin from 'firebase-admin';
import { freeTierHourlyLimit } from '../utils/rateLimit';

// =============================================================================
// CONSTANTS
// =============================================================================

export const FREE_LIFETIME_LIMIT = 10;

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

const PLAN_MODEL: Record<string, string> = {
  free: 'claude-haiku-4-5-20251001',
  lite: 'claude-haiku-4-5-20251001',
  pro:  'claude-sonnet-4-6',
  max:  'claude-sonnet-4-6',
};

export interface CreditCheckResult {
  success: boolean;
  message: string;
  remainingCredits?: number;
  model?: string;
  planType?: string;
}

// =============================================================================
// checkAndDeductCredits
// Atomically checks credits, enforces rate limits, deducts, and returns model.
// Called by the generate route BEFORE starting the AI pipeline.
// =============================================================================

export async function checkAndDeductCredits(
  userId: string,
  actionType: ActionType = 'full_build',
): Promise<CreditCheckResult> {
  // Owner accounts bypass all credit checks — unlimited builds, pro model
  const ownerUids = (process.env.OWNER_UIDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (ownerUids.includes(userId)) {
    return { success: true, message: 'Owner bypass', model: PLAN_MODEL['pro'] ?? PLAN_MODEL['free'], planType: 'pro', remainingCredits: 99999 };
  }

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
    const model    = PLAN_MODEL[planType] ?? PLAN_MODEL['free'];
    const isFree   = planType === 'free';

    // Free actions (clarify, chat) — skip deduction
    if (cost === 0) {
      return { success: true, message: 'No credits required', model, planType };
    }

    // ── FREE TIER ────────────────────────────────────────────────────────────
    if (isFree) {
      // Hourly build rate limit — 3 builds per hour per account
      const rl = freeTierHourlyLimit(userId);
      if (!rl.allowed) {
        const mins = Math.ceil(rl.retryAfterMs / 60_000);
        return {
          success: false,
          message: `Free accounts are limited to 3 builds per hour. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
          model,
          planType,
        };
      }

      // Lifetime build check
      const d = creditsSnap.exists ? creditsSnap.data()! : {};
      const lifetimeUsed  = Number(d.lifetime_builds_used  ?? 0);
      const lifetimeLimit = Number(d.free_lifetime_limit   ?? FREE_LIFETIME_LIMIT);
      const topup         = Number(d.topup_credits         ?? 0);

      // topup_credits can extend beyond the lifetime pool (paid top-up)
      const totalAvailable = Math.max(0, lifetimeLimit - lifetimeUsed) + topup;

      if (totalAvailable < cost) {
        return {
          success: false,
          message: `You've used all ${lifetimeLimit} lifetime free builds. Upgrade to Pro to keep building.`,
          model,
          planType,
        };
      }

      // Deduct: lifetime first, then topup
      let toDeduct = cost;
      const lifetimeRemaining = lifetimeLimit - lifetimeUsed;

      if (lifetimeRemaining >= toDeduct) {
        // Deduct entirely from lifetime
        tx.set(creditsRef, {
          user_id: userId,
          lifetime_builds_used: admin.firestore.FieldValue.increment(toDeduct),
          free_lifetime_limit:  lifetimeLimit,
          topup_credits:        topup,
          monthly_credits:      0,
          bonus_credits:        0,
          rollover_credits:     0,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          ...(creditsSnap.exists ? {} : { created_at: admin.firestore.FieldValue.serverTimestamp() }),
        }, { merge: true });
        toDeduct = 0;
      } else {
        // Exhaust lifetime, deduct remainder from topup
        const fromTopup = toDeduct - lifetimeRemaining;
        tx.set(creditsRef, {
          lifetime_builds_used: lifetimeLimit, // fully exhausted
          free_lifetime_limit:  lifetimeLimit,
          topup_credits:        Math.max(0, topup - fromTopup),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
          ...(creditsSnap.exists ? {} : { created_at: admin.firestore.FieldValue.serverTimestamp() }),
        }, { merge: true });
        toDeduct = 0;
      }

      const newLifetimeUsed = Math.min(lifetimeUsed + cost, lifetimeLimit);
      const balanceAfter = Math.max(0, lifetimeLimit - newLifetimeUsed) + Math.max(0, topup - Math.max(0, cost - (lifetimeLimit - lifetimeUsed)));

      const txLogRef = db.collection('creditTransactions').doc();
      tx.set(txLogRef, {
        user_id: userId,
        transaction_type: 'deduction',
        action_type: actionType,
        amount: -cost,
        balance_after: balanceAfter,
        description: `${actionType.replace(/_/g, ' ')} (${cost} credit${cost !== 1 ? 's' : ''})`,
        metadata: { planType, model, lifetime_builds_used: newLifetimeUsed },
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        success: true,
        message: 'Credits deducted',
        remainingCredits: balanceAfter,
        model,
        planType,
      };
    }

    // ── PAID TIER (pro / max / lite) ─────────────────────────────────────────
    if (!creditsSnap.exists) {
      tx.set(creditsRef, {
        user_id: userId,
        monthly_credits: 0,
        bonus_credits:   0,
        rollover_credits: 0,
        topup_credits:   0,
        lifetime_builds_used: 0,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      return {
        success: false,
        message: 'No credits available. Please top up or wait for your next billing cycle.',
        model,
        planType,
      };
    }

    const d = creditsSnap.data()!;
    const monthly  = Number(d.monthly_credits  ?? 0);
    const bonus    = Number(d.bonus_credits    ?? 0);
    const rollover = Number(d.rollover_credits ?? 0);
    const topup    = Number(d.topup_credits    ?? 0);
    const total    = monthly + bonus + rollover + topup;

    if (total < cost) {
      return {
        success: false,
        message: `Need ${cost} credit${cost !== 1 ? 's' : ''} (you have ${total}). Top up or upgrade your plan.`,
        model,
        planType,
      };
    }

    // Deduct in order: bonus → monthly → rollover → topup
    let toDeduct    = cost;
    let newBonus    = bonus;
    let newMonthly  = monthly;
    let newRollover = rollover;
    let newTopup    = topup;

    if (newBonus >= toDeduct) { newBonus -= toDeduct; toDeduct = 0; }
    else { toDeduct -= newBonus; newBonus = 0; }
    if (toDeduct > 0) {
      if (newMonthly >= toDeduct) { newMonthly -= toDeduct; toDeduct = 0; }
      else { toDeduct -= newMonthly; newMonthly = 0; }
    }
    if (toDeduct > 0) {
      if (newRollover >= toDeduct) { newRollover -= toDeduct; toDeduct = 0; }
      else { toDeduct -= newRollover; newRollover = 0; }
    }
    if (toDeduct > 0) newTopup = Math.max(0, newTopup - toDeduct);

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
