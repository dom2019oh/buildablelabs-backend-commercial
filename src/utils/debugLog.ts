// =============================================================================
// Debug Log — writes errors to Firestore _debugLogs (Admin SDK, bypasses rules)
// =============================================================================

import { db } from '../db/client';

export type LogType = 'backend_error' | 'frontend_error' | 'backend_warn';

export interface DebugEntry {
  type: LogType;
  timestamp: string;
  path: string;
  status?: number;
  message: string;
  userId?: string | null;
  details?: Record<string, unknown>;
}

export async function writeDebugLog(entry: DebugEntry): Promise<void> {
  try {
    await db().collection('_debugLogs').add({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Never throw from the logger itself
  }
}
