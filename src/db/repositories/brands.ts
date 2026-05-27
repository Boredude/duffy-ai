import { eq, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import {
  brands,
  type Brand,
  type BrandVoice,
  type BrandCadence,
  type BrandKit,
  type BrandDesignSystem,
  type IgAnalysisSnapshot,
} from '../schema.js';

export async function listActiveBrands(): Promise<Brand[]> {
  const db = getDb();
  return db.select().from(brands).where(eq(brands.status, 'active'));
}

export async function findBrandById(id: string): Promise<Brand | null> {
  const db = getDb();
  const rows = await db.select().from(brands).where(eq(brands.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateBrand(
  id: string,
  patch: Partial<{
    igHandle: string | null;
    websiteUrl: string | null;
    awaitingWebsiteReply: boolean;
    voiceJson: BrandVoice | null;
    cadenceJson: BrandCadence | null;
    brandKitJson: BrandKit | null;
    designSystemJson: BrandDesignSystem | null;
    igAnalysisJson: IgAnalysisSnapshot | null;
    brandBoardImageUrl: string | null;
    timezone: string;
    status: Brand['status'];
    conversationLanguageSample: string | null;
  }>,
): Promise<Brand> {
  const db = getDb();
  const rows = await db
    .update(brands)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(brands.id, id))
    .returning();
  if (!rows[0]) throw new Error(`Brand ${id} not found`);
  return rows[0];
}
