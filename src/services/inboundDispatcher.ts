import { getChannel } from '../channels/registry.js';
import type { BoundChannel, ChannelMessage } from '../channels/types.js';
import { logger } from '../config/logger.js';
import { loadBrandContext, type BrandContext } from '../context/BrandContext.js';
import { upsertBrandByChannel } from '../db/repositories/brandChannels.js';
import {
  findActiveRunForBrand,
  findRunByDraft,
  findRunningRunForBrand,
} from '../db/repositories/workflowRuns.js';
import { getDuffyAgent } from '../mastra/agents/duffy.js';
import { phraseAsDuffy } from '../mastra/agents/voice.js';
import { memoryFor } from '../mastra/memory.js';
import { handleSlashCommand, isSlashCommand } from './slashCommands.js';
import { resumeWorkflow, startWorkflow } from './workflowRunner.js';

/**
 * One-line summary of a brand's current state, embedded in the system
 * preamble so Duffy doesn't need to call `getBrandContext` just to
 * reply to a casual greeting. Kept compact on purpose — tools provide
 * full detail when the agent actually needs it.
 */
function buildBrandSummary(ctx: BrandContext): string {
  const b = ctx.brand;
  const parts = [
    `brandId=${b.id}`,
    `status=${b.status}`,
    `igHandle=${b.igHandle ?? '(not set)'}`,
    `timezone=${b.timezone}`,
    `kit=${b.brandKitJson ? 'present' : 'missing'}`,
    `cadence=${b.cadenceJson ? 'present' : 'missing'}`,
  ];
  const channelKinds = ctx.channels.map((c) => c.kind).join(',') || 'none';
  parts.push(`channels=${channelKinds}`);
  return parts.join(' ');
}

function buildUserPrompt(parsed: ChannelMessage, ctx: BrandContext): string {
  const summary = buildBrandSummary(ctx);
  const meta = `[${summary} channel=${parsed.channelKind} from=${parsed.externalUserId}]`;
  switch (parsed.kind) {
    case 'text':
      return `${meta}\n${parsed.text}`;
    case 'button':
      return `${meta}\n(The user tapped a button: id=${parsed.buttonId} title="${parsed.buttonTitle}")`;
    case 'image':
      return `${meta}\n(The user sent an image. mediaId=${parsed.mediaId})${
        parsed.caption ? ` Caption: ${parsed.caption}` : ''
      }`;
    case 'unsupported':
      return `${meta}\n(The user sent an unsupported message type: ${parsed.rawType})`;
  }
}

/**
 * Extracts a free-text reply from any inbound message kind so it can be fed
 * to a suspended workflow's `resumeSchema: { reply: string }`.
 */
function extractReplyText(parsed: ChannelMessage): string {
  switch (parsed.kind) {
    case 'text':
      return parsed.text;
    case 'button':
      return parsed.buttonTitle || parsed.buttonId;
    case 'image':
      return parsed.caption ?? '';
    case 'unsupported':
      return '';
  }
}

/**
 * Different workflows expect different resume shapes:
 *  - brandOnboarding: { reply: string }
 *  - postDraftApproval: { decision: 'approve'|'edit'|'reject', editNote?: string }
 *
 * For the approval flow we map button taps -> decision; if the user replies
 * with text instead of tapping a button, we treat it as an `edit` with that
 * text as the note.
 */
function buildResumeDataFor(workflowId: string, parsed: ChannelMessage): Record<string, unknown> {
  if (workflowId === 'postDraftApproval') {
    if (parsed.kind === 'button' && parsed.decision) {
      return { decision: parsed.decision };
    }
    if (parsed.kind === 'text') {
      return { decision: 'edit', editNote: parsed.text };
    }
    return { decision: 'edit', editNote: extractReplyText(parsed) };
  }
  return { reply: extractReplyText(parsed) };
}

/**
 * Dispatches an inbound channel message:
 *  1. If a Mastra workflow run is suspended for this brand (or the specific
 *     draft a button refers to), resume it with the user's reply.
 *  2. Otherwise, if the brand is brand-new (status pending), start the
 *     brandOnboarding workflow.
 *  3. Otherwise, hand off to the Duffy agent for free-form chat.
 */
export async function dispatchInboundMessage(parsed: ChannelMessage): Promise<void> {
  // Slash commands run before any brand/workflow plumbing so they can wipe
  // state cleanly (e.g. `/reset` deletes the brand row entirely).
  if (isSlashCommand(parsed)) {
    await handleSlashCommand(parsed);
    return;
  }

  const { brand } = await upsertBrandByChannel({
    kind: parsed.channelKind,
    externalId: parsed.externalUserId,
  });
  // The channel adapter is bound to the same external id we just upserted —
  // saves a follow-up DB read inside `getBrandChannel`.
  const channel: BoundChannel = getChannel(parsed.channelKind).bind(parsed.externalUserId);

  const log = logger.child({
    brandId: brand.id,
    channel: parsed.channelKind,
    externalUserId: parsed.externalUserId,
    kind: parsed.kind,
  });
  log.info('Inbound message received');

  let activeRun = null;
  if (parsed.kind === 'button' && parsed.draftId) {
    activeRun = await findRunByDraft(parsed.draftId);
  }
  if (!activeRun) {
    activeRun = await findActiveRunForBrand(brand.id);
  }

  if (activeRun) {
    log.info({ runId: activeRun.runId, workflowId: activeRun.workflowId }, 'Resuming workflow');
    try {
      const resumeData = buildResumeDataFor(activeRun.workflowId, parsed);
      await resumeWorkflow({
        workflowId: activeRun.workflowId as
          | 'brandOnboarding'
          | 'postDraftApproval'
          | 'startPost',
        runId: activeRun.runId,
        brandId: brand.id,
        ...(activeRun.draftId ? { draftId: activeRun.draftId } : {}),
        resumeData,
      });
    } catch (err) {
      log.error({ err, runId: activeRun.runId }, 'Failed to resume workflow');
      await channel.sendText("Sorry, something went off the rails on my side. Mind sending that one more time?");
    }
    return;
  }

  // Guard: if a workflow is actively running (not suspended), the user's
  // message arrived mid-processing. Send a hold-on ack and drop the message —
  // resuming is meaningless since no step is suspended and waiting for input.
  const runningRun = await findRunningRunForBrand(brand.id);
  if (runningRun) {
    const RUNNING_HINT: Record<string, string> = {
      brandOnboarding: 'analyzing your Instagram feed and building the brand kit',
      postDraftApproval: 'generating your post',
      startPost: 'kicking off a new post',
    };
    const hint = RUNNING_HINT[runningRun.workflowId] ?? 'working on something';
    log.info({ runId: runningRun.runId, workflowId: runningRun.workflowId }, 'Workflow running — sending busy ack');
    const msg = await phraseAsDuffy({
      goal: 'User sent a message while Duffy is actively processing something.',
      mustConvey: `I'm still ${hint} — I haven't forgotten them, will be right back.`,
      fallback: 'Still on it — I\'ll be right back with you in a moment!',
      brandId: brand.id,
    });
    await channel.sendText(msg);
    return;
  }

  if (brand.status === 'pending') {
    log.info('Starting brandOnboarding for new brand');
    try {
      await startWorkflow({
        workflowId: 'brandOnboarding',
        brandId: brand.id,
        inputData: { brandId: brand.id },
      });
    } catch (err) {
      log.error({ err }, 'Failed to start brandOnboarding');
      await channel.sendText("Hey! I'm Duffy. I had a small hiccup starting up — give me a minute and try again?");
    }
    return;
  }

  // Already-onboarded brand: free chat with the agent. Load the full
  // BrandContext once so we can hand Duffy a one-line summary up front and
  // skip a redundant `getBrandContext` tool call for casual replies.
  const brandContext = await loadBrandContext(brand.id);
  if (!brandContext) {
    // Shouldn't happen — we just upserted this brand. Fall back gracefully.
    log.error({ brandId: brand.id }, 'BrandContext load returned null after upsert');
    await channel.sendText('Sorry, I hit a snag on my end. Mind sending that again in a moment?');
    return;
  }

  const agent = getDuffyAgent();
  const prompt = buildUserPrompt(parsed, brandContext);

  let reply: string;
  try {
    const result = await agent.generate(prompt, { memory: memoryFor(brand.id) });
    reply = (result as { text?: string }).text?.trim() ?? '';
  } catch (err) {
    log.error({ err }, 'Duffy agent generate failed');
    reply = 'Sorry, I hit a snag on my end. Mind sending that again in a moment?';
  }

  if (reply) {
    await channel.sendText(reply);
  }
}
