import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { requireBrandChannel } from '../../channels/registry.js';
import { logger } from '../../config/logger.js';
import { startWorkflow } from '../../services/workflowRunner.js';
import { phraseAsDuffy } from '../agents/voice.js';

/**
 * `/post` command flow.
 *
 * Runs in two steps:
 *   1. `collectBrief` — if the user already gave a brief (e.g. via
 *      `/post something about our summer menu`), pass it through; otherwise
 *      ask them on the channel and SUSPEND until they reply. The reply is
 *      used verbatim as the `briefingHint`. "any" (or similar) becomes no
 *      hint so the creative pipeline picks its own angle.
 *   2. `kickoffApproval` — starts the `postDraftApproval` workflow with the
 *      resolved brief. That workflow runs the creative pipeline, posts the
 *      preview for review, and loops on edits.
 *
 * Why two workflows instead of chaining the approval workflow directly:
 * `postDraftApproval` is a long-running, self-suspending workflow (generate
 * → request-approval → edit loop). Keeping `startPost` small and letting it
 * fully COMPLETE once the approval run is kicked off means the brand only
 * ever has one suspended run at a time — the approval one — which is what
 * the inbound dispatcher's `findActiveRunForBrand` assumes.
 */

const NO_HINT_REPLIES = /^(any|anything|no|nothing|skip|you decide|you pick|surprise me)\b/i;

const briefSchema = z
  .string()
  .trim()
  .max(1000)
  .describe('Free-text topic/angle hint for the post.');

const collectBrief = createStep({
  id: 'collect-brief',
  inputSchema: z.object({
    brandId: z.string(),
    briefingHint: briefSchema.optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    briefingHint: briefSchema.optional(),
  }),
  resumeSchema: z.object({ reply: z.string() }),
  suspendSchema: z.object({ awaiting: z.literal('post_brief') }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      const hint = inputData.briefingHint?.trim();
      if (hint) {
        return { brandId: inputData.brandId, briefingHint: hint };
      }
      const channel = await requireBrandChannel(inputData.brandId);
      const briefAsk = await phraseAsDuffy({
        goal: 'Ask the brand what topic or angle they want for their next post.',
        mustConvey: "They should reply with a topic or angle, or 'any' to let me pick.",
        fallback: "What should this post be about? Reply with a topic or angle, or 'any' to let me pick.",
        brandId: inputData.brandId,
      });
      await channel.sendText(briefAsk);
      await suspend({ awaiting: 'post_brief' });
      return undefined as never;
    }

    const reply = resumeData.reply.trim();
    if (!reply || NO_HINT_REPLIES.test(reply)) {
      return { brandId: inputData.brandId };
    }
    return { brandId: inputData.brandId, briefingHint: reply };
  },
});

/**
 * How far out to schedule the delivery of a `/post`-initiated draft. The
 * brand is manually kicking off an ad-hoc post, so defaulting to "publish
 * ~60 minutes after approval" matches the existing approval preview copy
 * ("Scheduled to send to you: …") without asking the user to pick a time.
 */
const DEFAULT_SCHEDULE_DELAY_MS = 60 * 60 * 1000;

const kickoffApproval = createStep({
  id: 'kickoff-approval',
  inputSchema: z.object({
    brandId: z.string(),
    briefingHint: briefSchema.optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    approvalRunId: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { brandId, briefingHint } = inputData;
    const scheduledAt = new Date(Date.now() + DEFAULT_SCHEDULE_DELAY_MS);
    const started = await startWorkflow({
      workflowId: 'postDraftApproval',
      brandId,
      inputData: {
        brandId,
        scheduledAt: scheduledAt.toISOString(),
        ...(briefingHint ? { briefingHint } : {}),
      },
    });
    logger.info(
      { brandId, approvalRunId: started.runId, status: started.status },
      'startPost: kicked off postDraftApproval',
    );
    return { brandId, approvalRunId: started.runId };
  },
});

export const startPostWorkflow = createWorkflow({
  id: 'startPost',
  inputSchema: z.object({
    brandId: z.string(),
    briefingHint: briefSchema.optional(),
  }),
  outputSchema: z.object({
    brandId: z.string(),
    approvalRunId: z.string(),
  }),
})
  .then(collectBrief)
  .then(kickoffApproval)
  .commit();
