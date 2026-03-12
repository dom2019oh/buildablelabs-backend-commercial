// =============================================================================
// Firestore Client (Firebase Admin)
// =============================================================================

import admin from 'firebase-admin';

export const db = () => admin.firestore();
