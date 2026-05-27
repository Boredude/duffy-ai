import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { requireBrandChannel } from '../../channels/registry.js';
import { logger } from '../../config/logger.js';
import { findBrandById } from '../../db/repositories/brands.js';
import {
  appendEditNote,
  findDraftById,
  updateDraftStatus,
} from '../../db/repositories/postDrafts.js';
import { QUEUES, getBoss } from '../../jobs/queue.js';
import {
  buildEditDirective,
  classifyEditIntent,
} from '../../services/creative/editIntent.js';
import { getContentType } from '../../services/creative/registry.js';
import { runCreativePipeline } from '../../services/creative/runCreativePipeline.js';
import { stepIdSchema } from '../../services/creative/types.js';
import { phraseAsDuffy } from '../agents/voice.js';

/**
 * Post-draft approval workflow.
 *
 * 1. generate     → builds caption + image and creates a `post_drafts` row
 * 2. requestApproval → sends WA preview with [Approve | Edit | Reject] buttons,
 *                       SUSPENDS waiting for the brand to tap a button (or text reply)
 * 3. handleDecision → branches:
 *      - approve → mark approved, schedule pg-boss `deliverApprovedPost` at scheduled_at
 *      - edit    → record note, regenerate (loops back via dountil)
 *      - reject  → mark rejected
 *
 * The edit loop uses Mastra's `dountil` so an unhappy brand can iterate as
 * many times as they want before approving.
 */

const decisionSchema = z.enum(['approve', 'edit', 'reject']);

const DEFAULT_CONTENT_TYPE_ID = 'igSinglePost';

const editDirectiveSchema = z.object({
  note: z.string(),
  invalidate: z.array(stepIdSchema).default([]),
});

const generate = createStep({
  id: 'generate',
  inputSchema: z.object({
    brandId: z.string(),
    scheduledAt: z.string().describe('ISO date for delivery via WA when approved'),
    briefingHint: z.string().optional(),
    existingDraftId: z.string().optional(),
    contentTypeId: z.string().default(DEFAULT_CONTENT_TYPE_ID),
    editDirective: editDirectiveSchema.optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
  }),
  execute: async ({ inputData }) => {
    const {
      brandId,
      scheduledAt,
      briefingHint,
      existingDraftId,
      contentTypeId,
      editDirective,
    } = inputData;
    try {
      const result = await runCreativePipeline({
        brandId,
        contentTypeId,
        scheduledAt: new Date(scheduledAt),
        ...(briefingHint ? { briefingHint } : {}),
        ...(existingDraftId ? { existingDraftId } : {}),
        ...(editDirective ? { editDirective } : {}),
      });

      return { brandId, draftId: result.draftId, scheduledAt };
    } catch (err) {
      // Never let a pipeline failure turn into dead silence on the user's
      // phone. Mastra still marks the run failed (we rethrow below); the
      // DM is just so the brand knows something broke and can retry. The
      // user-facing copy is intentionally vague — the real error is in logs.
      logger.error(
        { err, brandId, contentTypeId, isEditAttempt: !!editDirective },
        'postDraftApproval.generate: creative pipeline failed',
      );
      try {
        const channel = await requireBrandChannel(brandId);
        const message = editDirective
          ? await phraseAsDuffy({
              goal: 'Inform the brand that a draft regeneration failed and ask them to try again.',
              mustConvey: "The regeneration didn't work. They should try sending their edit again, or /reset if it stays stuck.",
              fallback: "I couldn't regenerate that draft — try sending your edit again, or /reset if it stays stuck.",
              brandId,
            })
          : await phraseAsDuffy({
              goal: 'Inform the brand that post generation failed and ask them to try again later.',
              mustConvey: 'Something went wrong on my end drafting the post. They should give it a minute and try /post again. /reset will clear stuck state if it keeps failing.',
              fallback: "I hit a snag drafting your post — give it a minute and try /post again. If it keeps failing, /reset will clear any stuck state.",
              brandId,
            });
        await channel.sendText(message);
      } catch (notifyErr) {
        logger.error(
          { err: notifyErr, brandId },
          'postDraftApproval.generate: failed to notify brand about pipeline failure',
        );
      }
      throw err;
    }
  },
});

const requestApproval = createStep({
  id: 'request-approval',
  inputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    decision: decisionSchema,
    editNote: z.string().optional(),
  }),
  resumeSchema: z.object({
    decision: decisionSchema,
    editNote: z.string().optional(),
  }),
  suspendSchema: z.object({ draftId: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const brand = await findBrandById(inputData.brandId);
      if (!brand) throw new Error(`Brand ${inputData.brandId} not found`);
      const draft = await findDraftById(inputData.draftId);
      if (!draft) throw new Error(`Draft ${inputData.draftId} not found`);
      const imageUrl = draft.mediaUrls[0];
      if (!imageUrl) throw new Error(`Draft ${draft.id} has no media URL`);

      const when = new Date(inputData.scheduledAt).toLocaleString('en-US', {
        timeZone: brand.timezone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

      const body =
        `Here's a fresh post idea for @${brand.igHandle ?? 'your brand'} 👇\n\n` +
        `${draft.caption.length > 700 ? draft.caption.slice(0, 700) + '…' : draft.caption}\n\n` +
        `📅 Scheduled to send to you: ${when}`;

      const channel = await requireBrandChannel(brand.id);
      if (channel.capabilities.supportsImageWithButtons) {
        await channel.sendImageWithButtons({
          imageUrl,
          bodyText: body,
          footer: 'Tap a button below',
          buttons: [
            { id: `approve_${draft.id}`, title: 'Approve' },
            { id: `edit_${draft.id}`, title: 'Edit' },
            { id: `reject_${draft.id}`, title: 'Reject' },
          ],
        });
      } else {
        // Capability fallback: send the image, then ask for a textual reply.
        await channel.sendImage(imageUrl, body);
        const fallbackPrompt = await phraseAsDuffy({
          goal: 'Ask the brand to reply with their decision on the post draft.',
          mustConvey: "They should reply with 'approve', 'edit', or 'reject'.",
          fallback: "Reply 'approve', 'edit', or 'reject' to let me know what you think.",
          brandId: brand.id,
        });
        await channel.sendText(fallbackPrompt);
      }
      await updateDraftStatus(draft.id, 'pending_approval');

      await suspend({ draftId: draft.id });
      return undefined as never;
    }

    return {
      ...inputData,
      decision: resumeData.decision,
      ...(resumeData.editNote ? { editNote: resumeData.editNote } : {}),
    };
  },
});

const handleDecision = createStep({
  id: 'handle-decision',
  inputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    decision: decisionSchema,
    editNote: z.string().optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    finalDecision: decisionSchema,
    briefingHint: z.string().optional(),
    existingDraftId: z.string().optional(),
    editDirective: editDirectiveSchema.optional(),
  }),
  execute: async ({ inputData }) => {
    const { brandId, draftId, scheduledAt, decision, editNote } = inputData;
    const brand = await findBrandById(brandId);
    if (!brand) throw new Error(`Brand ${brandId} not found`);
    const channel = await requireBrandChannel(brandId);

    if (decision === 'approve') {
      await updateDraftStatus(draftId, 'approved');
      const boss = await getBoss();
      await boss.send(
        QUEUES.deliverApprovedPost,
        { draftId, brandId },
        { startAfter: new Date(scheduledAt) },
      );
      const when = new Date(scheduledAt).toLocaleString('en-US', { timeZone: brand.timezone });
      const approvalMsg = await phraseAsDuffy({
        goal: "Celebrate that the brand approved the post and set their expectation for when it'll be delivered.",
        mustConvey: `The post is locked in. I'll send it back to them on ${when} so they can publish it.`,
        fallback: `Locked in 🔒 — I'll send the final post back to you on ${when} so you can publish it.`,
        context: { when, igHandle: brand.igHandle },
        brandId,
      });
      await channel.sendText(approvalMsg);
      logger.info({ draftId, brandId, scheduledAt }, 'Draft approved and delivery scheduled');
      return { brandId, draftId, scheduledAt, finalDecision: decision };
    }

    if (decision === 'reject') {
      await updateDraftStatus(draftId, 'rejected');
      const rejectMsg = await phraseAsDuffy({
        goal: 'Acknowledge that the brand rejected the post, warmly and without guilt.',
        mustConvey: "No problem — that draft is gone. I'll come back with a fresh angle next time.",
        fallback: "No worries — tossed that one. I'll come back with a different angle next time.",
        brandId,
      });
      await channel.sendText(rejectMsg);
      return { brandId, draftId, scheduledAt, finalDecision: decision };
    }

    // edit: record the note, classify which pipeline steps to invalidate,
    // and signal a targeted regeneration (the `generate` step above will
    // consume `editDirective` and rerun only the dirty steps).
    const note = editNote?.trim() || '';
    if (note) {
      await appendEditNote(draftId, { at: new Date().toISOString(), note });
    }
    const briefingHint = note || 'The user wants this post revised. Try a fresh angle.';

    // For MVP we use the single content-type pipeline. When we add carousel /
    // reel, the draft row will persist its contentTypeId and we'll look it
    // up here instead of hard-coding.
    const contentType = getContentType(DEFAULT_CONTENT_TYPE_ID);
    const availableSteps = contentType.pipeline.map((s) => s.id);
    const intent = await classifyEditIntent({ note: briefingHint, availableSteps });
    const editDirective = buildEditDirective(briefingHint, intent);
    logger.info(
      { draftId, invalidate: editDirective.invalidate, reasoning: intent.reasoning },
      'Edit intent classified',
    );

    const editAckMsg = await phraseAsDuffy({
      goal: 'Acknowledge the edit request and signal that regeneration is starting.',
      mustConvey: note
        ? `Got it — I'll take another swing with that in mind: "${note}".`
        : "On it — taking another swing now.",
      fallback: "On it — taking another swing now ✏️",
      context: note ? { editNote: note } : undefined,
      brandId,
    });
    await channel.sendText(editAckMsg);
    return {
      brandId,
      draftId,
      scheduledAt,
      finalDecision: decision,
      briefingHint,
      existingDraftId: draftId,
      editDirective,
    };
  },
});

/**
 * Inner loop: generate → ask → handle. We dountil the decision is no longer 'edit'.
 * Once it's 'approve' or 'reject' the loop exits and the workflow finishes.
 */
const reviseLoop = createWorkflow({
  id: 'postDraftApproval.reviseLoop',
  inputSchema: z.object({
    brandId: z.string(),
    scheduledAt: z.string(),
    briefingHint: z.string().optional(),
    existingDraftId: z.string().optional(),
    contentTypeId: z.string().default(DEFAULT_CONTENT_TYPE_ID),
    editDirective: editDirectiveSchema.optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    finalDecision: decisionSchema,
    briefingHint: z.string().optional(),
    existingDraftId: z.string().optional(),
    editDirective: editDirectiveSchema.optional(),
  }),
})
  .then(generate)
  .then(requestApproval)
  .then(handleDecision)
  .commit();

export const postDraftApprovalWorkflow = createWorkflow({
  id: 'postDraftApproval',
  inputSchema: z.object({
    brandId: z.string(),
    scheduledAt: z.string(),
    briefingHint: z.string().optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    draftId: z.string(),
    scheduledAt: z.string(),
    finalDecision: decisionSchema,
  }),
})
  .dountil(reviseLoop, async ({ inputData }) => inputData.finalDecision !== 'edit')
  .commit();
