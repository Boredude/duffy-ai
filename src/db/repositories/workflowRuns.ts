import { and, eq, sql, desc } from 'drizzle-orm';
import { getDb } from '../client.js';
import { workflowRuns, type WorkflowRun, type NewWorkflowRun } from '../schema.js';

export async function recordRun(input: NewWorkflowRun): Promise<WorkflowRun> {
  const db = getDb();
  const rows = await db.insert(workflowRuns).values(input).returning();
  if (!rows[0]) throw new Error('Failed to insert workflow run');
  return rows[0];
}

export async function markSuspended(
  runId: string,
  patch: { suspendedStep: string; suspendPayload: Record<string, unknown> | null },
): Promise<WorkflowRun | null> {
  const db = getDb();
  const rows = await db
    .update(workflowRuns)
    .set({ status: 'suspended', ...patch, updatedAt: sql`now()` })
    .where(eq(workflowRuns.runId, runId))
    .returning();
  return rows[0] ?? null;
}

export async function markRunStatus(
  runId: string,
  status: WorkflowRun['status'],
): Promise<WorkflowRun | null> {
  const db = getDb();
  const rows = await db
    .update(workflowRuns)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(workflowRuns.runId, runId))
    .returning();
  return rows[0] ?? null;
}

export async function findActiveRunForBrand(brandId: string): Promise<WorkflowRun | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.brandId, brandId), eq(workflowRuns.status, 'suspended')))
    .orderBy(desc(workflowRuns.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function findRunningRunForBrand(brandId: string): Promise<WorkflowRun | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.brandId, brandId), eq(workflowRuns.status, 'running')))
    .orderBy(desc(workflowRuns.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function findRunByDraft(draftId: string): Promise<WorkflowRun | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.draftId, draftId), eq(workflowRuns.status, 'suspended')))
    .orderBy(desc(workflowRuns.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}
