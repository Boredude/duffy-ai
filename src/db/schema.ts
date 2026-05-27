import {
  pgTable,
  pgEnum,
  text,
  uuid,
  timestamp,
  jsonb,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Brand status during onboarding.
 *  - pending:   brand record created (we saw a phone), no profile yet
 *  - onboarding: in the middle of the onboarding workflow
 *  - active:    onboarded; receiving drafts
 *  - paused:    temporarily disabled by owner
 */
export const brandStatusEnum = pgEnum('brand_status', ['pending', 'onboarding', 'active', 'paused']);

/**
 * Lifecycle of a single post draft.
 */
export const draftStatusEnum = pgEnum('draft_status', [
  'draft',
  'pending_approval',
  'approved',
  'delivered',
  'rejected',
]);

export const workflowRunStatusEnum = pgEnum('workflow_run_status', [
  'running',
  'suspended',
  'completed',
  'failed',
]);

/**
 * The kinds of channels through which a brand owner can talk to Duffy.
 * v1 only ships WhatsApp; the other values are placeholders so the column
 * type doesn't need a migration when we add SMS/Telegram/etc.
 *
 * `instagram`/`tiktok` are reserved for the future case where a brand connects
 * one of those as an owner-facing channel — distinct from "Duffy posts to it",
 * which is content-direction and lives elsewhere.
 */
export const channelKindEnum = pgEnum('channel_kind', [
  'whatsapp',
  'sms',
  'telegram',
  'instagram',
  'tiktok',
]);

export const brandChannelStatusEnum = pgEnum('brand_channel_status', [
  'connected',
  'pending',
  'revoked',
]);

export const brands = pgTable('brands', {
  id: uuid('id').defaultRandom().primaryKey(),
  igHandle: text('ig_handle'),
  websiteUrl: text('website_url'),
  // Transient flag set while the brand-kit step is awaiting a user reply to
  // the "do you have a website?" prompt. Cleared once we've consumed the
  // reply (URL or skip). Lets us distinguish a website reply from a
  // retry / new-handle reply when both arrive in the same sub-state.
  awaitingWebsiteReply: boolean('awaiting_website_reply').default(false).notNull(),
  // A short sample of the user's writing in their non-English language, used to
  // preserve language continuity when the next message (e.g. an IG handle) is ASCII.
  conversationLanguageSample: text('conversation_language_sample'),
  voiceJson: jsonb('voice_json').$type<BrandVoice | null>().default(null),
  cadenceJson: jsonb('cadence_json').$type<BrandCadence | null>().default(null),
  brandKitJson: jsonb('brand_kit_json').$type<BrandKit | null>().default(null),
  designSystemJson: jsonb('design_system_json').$type<BrandDesignSystem | null>().default(null),
  igAnalysisJson: jsonb('ig_analysis_json').$type<IgAnalysisSnapshot | null>().default(null),
  brandBoardImageUrl: text('brand_board_image_url'),
  timezone: text('timezone').default('UTC').notNull(),
  status: brandStatusEnum('status').default('pending').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A brand can be reached on multiple channels (WhatsApp today; SMS, Telegram,
 * etc. later). `(kind, externalId)` is unique globally — that's how an
 * inbound webhook resolves which brand a message is from. `isPrimary` marks
 * the default outbound channel used when nothing else is specified.
 */
export const brandChannels = pgTable(
  'brand_channels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    kind: channelKindEnum('kind').notNull(),
    externalId: text('external_id').notNull(),
    isPrimary: boolean('is_primary').default(false).notNull(),
    status: brandChannelStatusEnum('status').default('connected').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown> | null>().default(null),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    kindExternalIdx: uniqueIndex('brand_channels_kind_external_idx').on(t.kind, t.externalId),
    brandKindIdx: index('brand_channels_brand_kind_idx').on(t.brandId, t.kind),
  }),
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    waThreadId: text('wa_thread_id'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    brandIdx: index('conversations_brand_idx').on(t.brandId),
  }),
);

export const postDrafts = pgTable(
  'post_drafts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    caption: text('caption').notNull(),
    mediaUrls: jsonb('media_urls').$type<string[]>().default([]).notNull(),
    suggestedAt: timestamp('suggested_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    status: draftStatusEnum('status').default('draft').notNull(),
    editNotes: jsonb('edit_notes').$type<EditNote[] | null>().default(null),
    // Structured per-step output from the creative pipeline. Lets the approval
    // loop regenerate a single step (e.g. swap the image but keep the copy)
    // by invalidating + re-running only that step's artifact. The shape is
    // validated via `postDraftGenerationSchema` from `services/creative/types`.
    generation: jsonb('generation').$type<PostDraftGeneration | null>().default(null),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    brandIdx: index('post_drafts_brand_idx').on(t.brandId),
    statusIdx: index('post_drafts_status_idx').on(t.status),
    scheduledIdx: index('post_drafts_scheduled_idx').on(t.scheduledAt),
  }),
);

/**
 * Maps a (brand + draft) tuple to the Mastra workflow run that is suspended
 * waiting for a WhatsApp reply, so the inbound webhook can resolve the run
 * to call `run.resume(...)`.
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id').references(() => postDrafts.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    suspendedStep: text('suspended_step'),
    suspendPayload: jsonb('suspend_payload').$type<Record<string, unknown> | null>().default(null),
    status: workflowRunStatusEnum('status').default('running').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runIdIdx: uniqueIndex('workflow_runs_run_id_idx').on(t.runId),
    brandStatusIdx: index('workflow_runs_brand_status_idx').on(t.brandId, t.status),
    draftIdx: index('workflow_runs_draft_idx').on(t.draftId),
  }),
);

/**
 * Webhook idempotency dedupe table — keyed by Kapso's `X-Idempotency-Key`.
 * Inserts use `ON CONFLICT DO NOTHING` semantics in code.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    source: text('source').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
);

// ---- JSON shapes ----

export type BrandVoice = {
  summary: string;
  tone: string[];
  audience: string;
  do: string[];
  dont: string[];
  hashtags?: string[];
  themes?: string[];
  emojiUsage?: 'none' | 'sparing' | 'frequent';
  hashtagPolicy?: string;
};

export type BrandCadence = {
  postsPerWeek: number;
  preferredHourLocal?: number;
  daysOfWeek?: number[];
};

export type EditNote = {
  at: string;
  note: string;
};

/**
 * Structured output of the creative pipeline. The canonical runtime shape
 * lives in `src/services/creative/types.ts` as `PostDraftGeneration`; we
 * re-declare a loose type alias here only so Drizzle can attach it to the
 * `generation` jsonb column without a circular import back into services/.
 */
export type PostDraftGeneration = {
  contentTypeId: string;
  steps: Partial<Record<string, unknown>>;
  editHistory: Array<{ at: string; note: string; invalidated: string[] }>;
};

export type BrandPaletteEntry = {
  hex: string;
  role: 'primary' | 'secondary' | 'accent' | 'background' | 'text' | 'other';
  name?: string;
};

export type BrandLogo = {
  markType: 'wordmark' | 'symbol' | 'combo' | 'monogram' | 'none';
  description: string;
  colors: string[];
  hasTagline: boolean;
  profilePicUrl?: string;
};

export type BrandKit = {
  palette: BrandPaletteEntry[];
  typography: {
    mood: string;
    sample?: string;
    headingFont?: string;
    bodyFont?: string;
    fontFamilies?: string[];
    source?: 'instagram' | 'website' | 'mixed';
  };
  logo?: BrandLogo;
};

export type BrandDesignSystem = {
  photoStyle: string;
  illustrationStyle: string;
  composition: string;
  lighting: string;
  recurringMotifs: string[];
  doVisuals: string[];
  dontVisuals: string[];
};

export type IgAnalysisSnapshot = {
  capturedAt: string;
  handle: string;
  profile: {
    fullName?: string;
    biography?: string;
    followers?: number;
    following?: number;
    postsCount?: number;
    profilePicUrl?: string;
    isVerified?: boolean;
    externalUrl?: string;
  };
  posts: Array<{
    url: string;
    imageUrl: string;
    caption: string;
    likes?: number;
    comments?: number;
    timestamp?: string;
    type?: 'image' | 'video' | 'sidecar' | 'reel';
  }>;
  rawVisuals?: unknown;
  rawVoice?: unknown;
  rawProfilePic?: unknown;
  rawWebsite?: unknown;
};

// ---- Inferred row types ----

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;
export type BrandChannel = typeof brandChannels.$inferSelect;
export type NewBrandChannel = typeof brandChannels.$inferInsert;
export type ChannelKind = (typeof channelKindEnum.enumValues)[number];
export type BrandChannelStatus = (typeof brandChannelStatusEnum.enumValues)[number];
export type PostDraft = typeof postDrafts.$inferSelect;
export type NewPostDraft = typeof postDrafts.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
