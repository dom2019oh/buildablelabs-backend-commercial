// =============================================================================
// Database Query Helpers — Firestore
// =============================================================================

import { db } from './client';

// =============================================================================
// WORKSPACE QUERIES
// =============================================================================

export async function getOrCreateWorkspace(projectId: string, userId: string) {
  const snapshot = await db().collection('workspaces')
    .where('project_id', '==', projectId)
    .where('user_id', '==', userId)
    .limit(1)
    .get();

  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() };
  }

  const now = new Date().toISOString();
  const ref = await db().collection('workspaces').add({
    project_id: projectId,
    user_id: userId,
    status: 'ready',
    created_at: now,
    updated_at: now,
  });

  const newDoc = await ref.get();
  return { id: newDoc.id, ...newDoc.data() };
}

export async function getWorkspace(workspaceId: string, userId: string) {
  const doc = await db().collection('workspaces').doc(workspaceId).get();
  if (!doc.exists || doc.data()?.user_id !== userId) return null;
  return { id: doc.id, ...doc.data() };
}

export async function updateWorkspaceStatus(
  workspaceId: string,
  status: 'initializing' | 'ready' | 'generating' | 'error' | 'archived'
) {
  await db().collection('workspaces').doc(workspaceId).update({
    status,
    updated_at: new Date().toISOString(),
  });
}

export async function updateWorkspace(workspaceId: string, updates: Record<string, unknown>) {
  await db().collection('workspaces').doc(workspaceId).update({
    ...updates,
    updated_at: new Date().toISOString(),
  });
}

// =============================================================================
// FILE QUERIES
// =============================================================================

export async function getWorkspaceFiles(workspaceId: string): Promise<Array<{ id: string; file_path: string; content: string; [key: string]: unknown }>> {
  const snapshot = await db().collection('workspaceFiles')
    .where('workspace_id', '==', workspaceId)
    .orderBy('file_path')
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as { id: string; file_path: string; content: string; [key: string]: unknown }));
}

export async function getFile(workspaceId: string, filePath: string) {
  const snapshot = await db().collection('workspaceFiles')
    .where('workspace_id', '==', workspaceId)
    .where('file_path', '==', filePath)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

export async function upsertFile(
  workspaceId: string,
  userId: string,
  filePath: string,
  content: string,
  fileType?: string
) {
  const snapshot = await db().collection('workspaceFiles')
    .where('workspace_id', '==', workspaceId)
    .where('file_path', '==', filePath)
    .limit(1)
    .get();

  const fileData = {
    workspace_id: workspaceId,
    user_id: userId,
    file_path: filePath,
    content,
    file_type: fileType || filePath.split('.').pop() || null,
    is_generated: true,
    updated_at: new Date().toISOString(),
  };

  if (!snapshot.empty) {
    await snapshot.docs[0].ref.update(fileData);
    return { id: snapshot.docs[0].id, ...fileData };
  }

  const ref = await db().collection('workspaceFiles').add({
    ...fileData,
    created_at: new Date().toISOString(),
  });
  return { id: ref.id, ...fileData };
}

export async function deleteFile(workspaceId: string, filePath: string) {
  const snapshot = await db().collection('workspaceFiles')
    .where('workspace_id', '==', workspaceId)
    .where('file_path', '==', filePath)
    .get();
  const batch = db().batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

// =============================================================================
// GENERATION SESSION QUERIES
// =============================================================================

export async function createSession(workspaceId: string, userId: string, prompt: string) {
  const ref = await db().collection('generationSessions').add({
    workspace_id: workspaceId,
    user_id: userId,
    prompt,
    status: 'pending',
    created_at: new Date().toISOString(),
  });
  const doc = await ref.get();
  return { id: doc.id, ...doc.data() };
}

export async function getSession(sessionId: string) {
  const doc = await db().collection('generationSessions').doc(sessionId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export async function updateSession(
  sessionId: string,
  updates: {
    status?: 'pending' | 'planning' | 'scaffolding' | 'generating' | 'validating' | 'completed' | 'failed';
    plan?: object;
    files_planned?: number;
    files_generated?: number;
    file_paths?: string[];
    error_message?: string;
    completed_at?: string;
    // Cost tracking — written once at end of pipeline
    cost_usd?: number;
    cost_breakdown?: object;
    tokens_total?: object;
  }
) {
  await db().collection('generationSessions').doc(sessionId).update(updates);
  const doc = await db().collection('generationSessions').doc(sessionId).get();
  return { id: doc.id, ...doc.data() };
}

export async function getSessions(workspaceId: string) {
  const snapshot = await db().collection('generationSessions')
    .where('workspace_id', '==', workspaceId)
    .orderBy('created_at', 'desc')
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// =============================================================================
// FILE OPERATION QUERIES
// =============================================================================

export async function recordFileOperation(
  workspaceId: string,
  userId: string,
  sessionId: string,
  operation: 'create' | 'update' | 'delete' | 'rename' | 'move',
  filePath: string,
  options?: {
    previousContent?: string;
    newContent?: string;
    previousPath?: string;
    aiModel?: string;
    aiReasoning?: string;
  }
) {
  const ref = await db().collection('fileOperations').add({
    workspace_id: workspaceId,
    user_id: userId,
    session_id: sessionId,
    operation,
    file_path: filePath,
    previous_content: options?.previousContent ?? null,
    new_content: options?.newContent ?? null,
    previous_path: options?.previousPath ?? null,
    ai_model: options?.aiModel ?? null,
    ai_reasoning: options?.aiReasoning ?? null,
    validated: false,
    applied: false,
    created_at: new Date().toISOString(),
  });
  const doc = await ref.get();
  return { id: doc.id, ...doc.data() };
}

export async function applyFileOperation(operationId: string) {
  await db().collection('fileOperations').doc(operationId).update({
    applied: true,
    validated: true,
  });
}

export async function getOperationHistory(workspaceId: string, limit = 100) {
  const snapshot = await db().collection('fileOperations')
    .where('workspace_id', '==', workspaceId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}
