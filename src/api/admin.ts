// =============================================================================
// Admin API — one-time setup endpoints
// POST /api/admin/claim  → sets admin: true custom claim on the caller's account
//   Only works if the caller's email matches ADMIN_EMAIL env var.
// =============================================================================

import { Hono } from 'hono';
import admin from 'firebase-admin';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const app = new Hono();

// POST /api/admin/claim
// Call this once from the browser while logged in as the founder account.
// Sets Firebase custom claim { admin: true } — unlocks Firestore admin rules.
app.post('/claim', async (c) => {
  if (!env.ADMIN_EMAIL) {
    return c.json({ error: 'ADMIN_EMAIL not configured on the server.' }, 503);
  }

  const user = c.get('user') as admin.auth.DecodedIdToken;

  if (user.email?.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) {
    logger.warn({ email: user.email }, 'admin/claim: email mismatch');
    return c.json({ error: 'Not authorised.' }, 403);
  }

  try {
    await admin.auth().setCustomUserClaims(user.uid, { admin: true });
    logger.info({ uid: user.uid, email: user.email }, 'Admin claim granted');
    return c.json({ success: true, message: `Admin claim set for ${user.email}. Sign out and back in to refresh your token.` });
  } catch (err: any) {
    logger.error({ err }, 'Failed to set admin claim');
    return c.json({ error: err.message ?? 'Failed to set admin claim.' }, 500);
  }
});

export { app as adminRoutes };
