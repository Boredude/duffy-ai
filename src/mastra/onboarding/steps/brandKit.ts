import { logger } from '../../../config/logger.js';
import type { BoundChannel } from '../../../channels/types.js';
import { findBrandById, updateBrand } from '../../../db/repositories/brands.js';
import type { Brand } from '../../../db/schema.js';
import {
  fetchInstagramProfile,
  InstagramScraperError,
  type InstagramScrapeResult,
} from '../../../services/apify/instagramScraper.js';
import { analyzeBrand } from '../../../services/onboarding/analyzeBrand.js';
import { normalizeWebsiteUrl } from '../../../services/onboarding/analyzeWebsite.js';
import {
  buildBrandBoardCaption,
  generateBrandBoard,
} from '../../../services/onboarding/brandBoardImage.js';
import { classifyReviewIntent } from '../../../services/onboarding/classifyReviewIntent.js';
import { extractHandleWithLLM } from '../../../services/onboarding/extractHandle.js';
import {
  REVIEW_PROMPT,
  RETRY_HANDLE_PROMPT,
  buildBrandKitRecap,
  isExplicitApproval,
  looksLikeHandle,
} from '../../../services/onboarding/recap.js';
import { getDuffyAgent } from '../../agents/duffy.js';
import { phraseAsDuffy, sanitizeUserFacingFromDuffy } from '../../agents/voice.js';
import { memoryFor } from '../../memory.js';
import type { OnboardingStep, OnboardingStepContext, OnboardingStepResult } from '../types.js';

/**
 * Brand-kit onboarding step: ask for the IG handle, run the analysis fan-out
 * (visuals + voice; future: screenshot grid, competitor scrape), present the
 * kit for review, and accept approval / edit / retry replies until the user
 * locks it in.
 *
 * This step replaces the previous v3 `ask-ig-handle` + `run-analysis-and-confirm`
 * Mastra steps. It keeps the same sub-flow but compacts it into a single
 * re-entrant `OnboardingStep`. Sub-state is recovered from the brand row on
 * each resume:
 *   - no `igHandle`        → user is answering "what's your IG handle?"
 *   - handle, no `brandKitJson` → analysis previously failed; user is replying
 *                                  with retry / a new handle / clarification
 *   - has `brandKitJson`   → user is reviewing (approve / new handle / edit)
 */

async function presentBrandKitToUser(
  brand: Brand,
  channel: BoundChannel,
  opts: { force?: boolean } = {},
): Promise<void> {
  try {
    const { url } = await generateBrandBoard(brand, opts);
    const caption = await phraseAsDuffy({
      goal: 'Caption sent alongside a generated brand-board image. ONE short, purely descriptive line that intros the board — do NOT ask any question, do NOT prompt for approval; the next message handles the ask.',
      mustConvey: "This is how you're reading the given handle. State it as a one-line intro. Do not ask if it feels right — that question belongs in the follow-up message, not here.",
      brandId: brand.id,
      context: { igHandle: brand.igHandle },
      fallback: buildBrandBoardCaption(brand),
      maxChars: 140,
    });
    await channel.sendImage(url, caption);
  } catch (err) {
    logger.error(
      { err, brandId: brand.id },
      'Brand board image generation failed; falling back to text recap',
    );
    await channel.sendText(buildBrandKitRecap(brand));
  }
  await channel.sendText(
    await phraseAsDuffy({
      goal: "Right after the brand-board image: invite them to lock it in (YES) or tell you what to tweak. Mention they can also send a different handle to try.",
      mustConvey: 'Reply YES to lock it in, OR tell you what to tweak (give one tiny example like "more playful" or "swap the green for navy"), OR send a different handle to try.',
      brandId: brand.id,
      context: { igHandle: brand.igHandle },
      fallback: REVIEW_PROMPT,
    }),
  );
}

/**
 * Phrases the appropriate Duffy reply for a scrape/analysis failure and
 * returns the matching review-loop mode. Centralized so the scrape-only
 * probe and the full analyzeBrand path stay in lock-step.
 */
async function handleAnalysisFailure(
  brandId: string,
  handle: string,
  channel: BoundChannel,
  reason: 'not_found' | 'private' | 'empty' | 'rate_limited' | 'service_unavailable' | 'unknown',
): Promise<'retry_handle' | 'service_unavailable'> {
  if (reason === 'service_unavailable') {
    await channel.sendText(
      await phraseAsDuffy({
        goal: 'Tell them the analysis temporarily failed on your side. They can reply "retry" in a couple of minutes or send a different handle.',
        mustConvey: 'Temporary error on your side. They can reply "retry" in a couple of minutes, or send a different handle.',
        brandId,
        context: { igHandle: handle },
        fallback: `Argh — hit a temporary hiccup on my side analyzing @${handle}. Reply 'retry' in a couple of minutes, or send a different handle.`,
      }),
    );
    return 'service_unavailable';
  }
  const { goal, mustConvey, fallback } =
    reason === 'private'
      ? {
          goal: 'Tell them the IG account they gave is private and you can only analyze public ones. Ask for a different handle.',
          mustConvey:
            'The given handle is private. You can only analyze public accounts. Ask for a different handle.',
          fallback: `@${handle} looks private — I can only analyze public accounts. Send a different handle (without the @).`,
        }
      : reason === 'not_found'
        ? {
            goal: "Tell them you couldn't find that handle on Instagram. Ask them to double-check the spelling and resend (without the @).",
            mustConvey:
              "The handle was not found on Instagram. Ask them to double-check spelling and re-send without the @.",
            fallback: `Couldn't find @${handle} on Instagram. Double-check the spelling and send it again (without the @)?`,
          }
        : reason === 'empty'
          ? {
              goal: 'Tell them the account exists but has no posts you can analyze. Ask for a different handle.',
              mustConvey:
                'The account exists but has no posts to analyze yet. Ask for a different handle.',
              fallback: `@${handle} doesn't have any posts I can analyze yet. Send a different handle?`,
            }
          : {
              goal: "Generic: you couldn't read that account, ask them to send the handle again (without the @) and you'll retry.",
              mustConvey:
                "You couldn't read that account. Ask them to send the handle again (without the @) and you'll retry.",
              fallback: RETRY_HANDLE_PROMPT,
            };
  await channel.sendText(
    await phraseAsDuffy({
      goal,
      mustConvey,
      brandId,
      context: { igHandle: handle },
      fallback,
    }),
  );
  return 'retry_handle';
}

async function presentBrandKitOrAskRetry(
  brandId: string,
  handle: string,
  channel: BoundChannel,
  opts: {
    /** User- or scraper-provided website to feed into the website analyzer. */
    website?: string;
    /** Reuse a scrape we already pulled (e.g. during the externalUrl probe). */
    prefetchedScrape?: InstagramScrapeResult;
    /** Skip the "diving in…" message when the caller already sent it. */
    suppressDivingMessage?: boolean;
    /** Language sample from a prior user message — keeps response in the right language. */
    conversationLanguageSample?: string | null;
  } = {},
): Promise<'reviewing' | 'retry_handle' | 'service_unavailable'> {
  if (!opts.suppressDivingMessage) {
    await channel.sendText(
      await phraseAsDuffy({
        goal: "You just got a handle and are starting to scrape & analyze it. Tell them you're looking, and to give you a sec.",
        mustConvey: 'Tell them you are diving into the given handle now and to hold tight for a moment.',
        brandId,
        context: {
          igHandle: handle,
          ...(opts.conversationLanguageSample
            ? { conversationLanguageSample: opts.conversationLanguageSample }
            : {}),
        },
        fallback: `Diving into @${handle} now — give me a moment to study the feed.`,
      }),
    );
  }

  const result = await analyzeBrand({
    brandId,
    handle,
    ...(opts.website ? { website: opts.website } : {}),
    ...(opts.prefetchedScrape ? { prefetchedScrape: opts.prefetchedScrape } : {}),
  });
  if (!result.ok) {
    logger.warn(
      { brandId, handle, reason: result.reason },
      'Onboarding analysis failed',
    );
    return handleAnalysisFailure(brandId, handle, channel, result.reason);
  }

  const refreshed = await findBrandById(brandId);
  if (!refreshed) throw new Error(`Brand ${brandId} not found`);
  await presentBrandKitToUser(refreshed, channel);
  return 'reviewing';
}

/**
 * Pre-scrape the brand's IG profile so we can decide whether to ask the user
 * for a website URL before running the full analyzer fan-out. Returns one of:
 *  - `awaiting_website`: caller should suspend on `question: 'website'`
 *  - `reviewing` / `retry_handle` / `service_unavailable`: same modes as
 *    `presentBrandKitOrAskRetry` (the analysis already ran or failed).
 */
async function probeAndAnalyzeOrAskWebsite(
  brandId: string,
  handle: string,
  channel: BoundChannel,
  conversationLanguageSample?: string | null,
): Promise<'awaiting_website' | 'reviewing' | 'retry_handle' | 'service_unavailable'> {
  await channel.sendText(
    await phraseAsDuffy({
      goal: "You just got a handle and are starting to scrape & analyze it. Tell them you're looking, and to give you a sec.",
      mustConvey:
        'Tell them you are diving into the given handle now and to hold tight for a moment.',
      brandId,
      context: {
        igHandle: handle,
        ...(conversationLanguageSample ? { conversationLanguageSample } : {}),
      },
      fallback: `Diving into @${handle} now — give me a moment to study the feed.`,
    }),
  );

  let scrape: InstagramScrapeResult;
  try {
    scrape = await fetchInstagramProfile(handle);
  } catch (err) {
    if (err instanceof InstagramScraperError) {
      logger.warn(
        { brandId, handle, code: err.code, msg: err.message },
        'IG profile probe failed',
      );
      return handleAnalysisFailure(brandId, handle, channel, err.code);
    }
    logger.error({ err, brandId, handle }, 'IG profile probe threw unexpectedly');
    return handleAnalysisFailure(brandId, handle, channel, 'unknown');
  }

  const externalUrl = scrape.profile.externalUrl?.trim();
  if (externalUrl) {
    await updateBrand(brandId, { websiteUrl: externalUrl, awaitingWebsiteReply: false });
    return presentBrandKitOrAskRetry(brandId, handle, channel, {
      website: externalUrl,
      prefetchedScrape: scrape,
      suppressDivingMessage: true,
    });
  }

  // No website on the IG profile — ask the user. We can't carry the scrape
  // result across the suspend boundary, so on resume we'll re-scrape inside
  // analyzeBrand. That's a single extra Apify call in the no-externalUrl case
  // and lets us avoid serializing scrape blobs into Mastra suspend metadata.
  await updateBrand(brandId, { awaitingWebsiteReply: true });
  await channel.sendText(
    await phraseAsDuffy({
      goal: "You scraped the IG profile but didn't find a website link. Ask the user (optional) if they have one — fashion the ask casually. Tell them to paste the URL or reply 'skip' to continue without it.",
      mustConvey:
        "You couldn't find a website link on their IG profile. Ask if they have one (optional). They can paste the URL or reply 'skip' to continue.",
      brandId,
      context: { igHandle: handle },
      fallback: `Quick one: do you have a website I should peek at? Paste the URL or reply 'skip' to keep going.`,
    }),
  );
  return 'awaiting_website';
}

const SKIP_WEBSITE_RE = /^(skip|no|nope|none|n\/a|na)\b/i;

/**
 * Parse the user's reply to the "do you have a website?" prompt. Returns
 * `'skip'`, the normalized URL, or `null` if the reply doesn't look like
 * either (caller should re-ask).
 */
function parseWebsiteReply(reply: string): 'skip' | string | null {
  const trimmed = reply.trim();
  if (!trimmed) return null;
  if (SKIP_WEBSITE_RE.test(trimmed)) return 'skip';
  return normalizeWebsiteUrl(trimmed);
}

/**
 * Hand a brand-kit tweak to Duffy, then send the resulting confirmation
 * message back to the user — but never let Duffy's internal reasoning
 * reach the channel.
 *
 * The orchestrator model can be chatty about its plan ("I need to get the
 * brand context first…", "I see the kit is already locked in…") which is
 * fine for development but disastrous as a user-facing reply. We give it a
 * clean, customer-shaped prompt, sanitize the output, and fall back to a
 * deterministic `phraseAsDuffy` confirmation if the response leaks any
 * developer-facing plumbing or reads like a reasoning monologue.
 */
async function applyEditWithDuffy(opts: {
  brandId: string;
  igHandle: string | null;
  reply: string;
  editSummary: string;
  channel: BoundChannel;
}): Promise<void> {
  const { brandId, igHandle, reply, editSummary, channel } = opts;
  const handleLabel = igHandle ? `@${igHandle}` : 'their brand kit';

  let userFacing: string | null = null;
  try {
    const duffy = getDuffyAgent();
    const prompt = [
      `The user just reviewed the brand board for ${handleLabel} and asked for this tweak: "${editSummary}".`,
      `(Their original message was: "${reply}".)`,
      ``,
      `Apply the change if it maps to a stored field via your tools. Then reply with one short, warm WhatsApp line confirming what you noted in your own voice — only the message body the user should read. No plans, no narration, no labels.`,
    ].join('\n');
    const result = await duffy.generate(prompt, { memory: memoryFor(brandId) });
    userFacing = sanitizeUserFacingFromDuffy((result as { text?: string }).text);
  } catch (err) {
    logger.error({ err, brandId }, 'Brand kit edit handling failed');
  }

  if (userFacing) {
    await channel.sendText(userFacing);
    return;
  }

  // Fallback: deterministic, in-voice acknowledgement so the user never
  // sees a leaked monologue or an empty reply.
  await channel.sendText(
    await phraseAsDuffy({
      goal: "Acknowledge the user's requested tweak to the brand kit in one short line. Do NOT re-ask what to adjust — they already told you.",
      mustConvey: `You noted the requested change ("${editSummary}") and will factor it in. Don't promise specifics you haven't actually applied.`,
      brandId,
      context: { igHandle, requestedTweak: editSummary },
      fallback: `Got it — I'll factor in "${editSummary}" on the next pass.`,
      maxChars: 220,
    }),
  );
}

async function executeBrandKit(ctx: OnboardingStepContext): Promise<OnboardingStepResult> {
  const { brandId, channel, resumeData } = ctx;
  let brand = ctx.brand;

  // First-entry path (no user reply yet).
  if (!resumeData) {
    if (!brand.igHandle) {
      // Ask for the IG handle.
      await updateBrand(brandId, { status: 'onboarding' });
      await channel.sendText(
        await phraseAsDuffy({
          goal: 'First message to a brand-new user. Introduce yourself in one breath, say in one short line that you help plan & draft Instagram posts, and ask for their IG handle to get started.',
          mustConvey:
            'You are Duffy. You help plan and draft Instagram posts. Ask for their Instagram handle.',
          brandId,
          fallback:
            "Hey, I'm Duffy — your AI content partner. I'll help you plan and draft Instagram posts. To start, what's your Instagram handle?",
        }),
      );
      ctx.suspend({ question: 'ig_handle' });
    }
    // We somehow re-entered with a handle but no kit (e.g. retry after a
    // service blip). Run the analysis now. Type-narrowing: brand.igHandle
    // is non-null here (the previous branch suspended).
    if (!brand.brandKitJson) {
      const handle = brand.igHandle as string;
      const outcome = await probeAndAnalyzeOrAskWebsite(
        brandId,
        handle,
        channel,
        brand.conversationLanguageSample,
      );
      if (outcome === 'awaiting_website') {
        ctx.suspend({ question: 'website' });
      }
      ctx.suspend({ question: 'brand_kit_review', mode: outcome });
    }
    await presentBrandKitToUser(brand, channel);
    ctx.suspend({ question: 'brand_kit_review', mode: 'reviewing' });
  }

  const reply = resumeData.reply.trim();

  // Sub-state 1: still awaiting an IG handle.
  if (!brand.igHandle) {
    const extracted = await extractHandleWithLLM(reply);
    if (extracted) {
      await updateBrand(brandId, { igHandle: extracted });
      const outcome = await probeAndAnalyzeOrAskWebsite(
        brandId,
        extracted,
        channel,
        brand.conversationLanguageSample,
      );
      if (outcome === 'awaiting_website') {
        ctx.suspend({ question: 'website' });
      }
      ctx.suspend({ question: 'brand_kit_review', mode: outcome });
    }
    // Detect and persist the user's language when they write in a non-ASCII script.
    // This lets future phraseAsDuffy calls (e.g. the "diving in" message after the
    // handle is submitted) stay in the right language even when the handle itself is ASCII.
    const hasNonAscii = /[^ -]/.test(reply);
    if (hasNonAscii && !brand.conversationLanguageSample) {
      await updateBrand(brandId, { conversationLanguageSample: reply.slice(0, 80) });
    }

    const isInvalidFormat = looksLikeHandle(reply);
    const { goal, mustConvey, fallback, maxChars } = isInvalidFormat
      ? {
          goal: "The user replied with something that is clearly not an IG handle. Tell them what shape you need (e.g. @nike, nike, or instagram.com link) and re-ask.",
          mustConvey:
            "What they sent doesn't look like an Instagram handle. You need a username (like @nike or just nike) or an instagram.com link. Ask them to send it again.",
          fallback:
            "That doesn't look like a valid Instagram handle. Send your username (like @nike, nike, or the full instagram.com link) and I'll try again.",
          maxChars: undefined,
        }
      : {
          goal: 'The user replied without a usable Instagram handle. React naturally to what they actually said (answer briefly if it\'s a question, acknowledge if it\'s small talk), then ask them to send the IG handle.',
          mustConvey:
            "Acknowledge or briefly answer their message in 1 short sentence based on the userMessage in context. If it's a greeting or small talk you don't fully understand, respond warmly (e.g. \"Hey!\") — NEVER say you don't understand or that the message doesn't make sense. Then ask them to send the IG handle (e.g. @theirname). NEVER claim you received their handle, found their account, are setting anything up, or are about to take action — you have NOT received a usable handle yet.",
          fallback:
            "Hey! To get started I just need your Instagram handle — send your username (like @nike) or the full instagram.com link?",
          maxChars: 320,
        };
    await channel.sendText(
      await phraseAsDuffy({
        goal,
        mustConvey,
        brandId,
        context: {
          userMessage: reply,
          ...(brand.conversationLanguageSample
            ? { conversationLanguageSample: brand.conversationLanguageSample }
            : hasNonAscii
              ? { conversationLanguageSample: reply.slice(0, 80) }
              : {}),
        },
        fallback,
        ...(maxChars ? { maxChars } : {}),
      }),
    );
    ctx.suspend({ question: 'ig_handle' });
  }

  // Sub-state 2a: have handle, no kit, and we previously asked for a website.
  // Reply is the user's URL or 'skip'.
  if (!brand.brandKitJson && brand.awaitingWebsiteReply && brand.igHandle) {
    const handle = brand.igHandle;
    const parsed = parseWebsiteReply(reply);
    if (parsed === null) {
      await channel.sendText(
        await phraseAsDuffy({
          goal: "The user replied to your website prompt with something that's neither a URL nor a clear skip. Ask again, briefly: paste the URL or reply 'skip'.",
          mustConvey:
            "What they sent isn't a URL and isn't a skip. Re-ask: paste the URL or reply 'skip'.",
          brandId,
          context: { igHandle: handle },
          fallback:
            "Hmm, that didn't look like a URL. Paste the website (e.g. nike.com) or reply 'skip' to continue without it.",
        }),
      );
      ctx.suspend({ question: 'website' });
    }
    if (parsed === 'skip') {
      await updateBrand(brandId, { awaitingWebsiteReply: false, websiteUrl: null });
      const mode = await presentBrandKitOrAskRetry(brandId, handle, channel);
      ctx.suspend({ question: 'brand_kit_review', mode });
    }
    // parsed is a normalized URL string.
    await updateBrand(brandId, { awaitingWebsiteReply: false, websiteUrl: parsed });
    const mode = await presentBrandKitOrAskRetry(brandId, handle, channel, {
      website: parsed,
    });
    ctx.suspend({ question: 'brand_kit_review', mode });
  }

  // Sub-state 2b: have handle but no brand kit — previous analysis failed,
  // user replied with retry / new handle / clarification.
  if (!brand.brandKitJson) {
    const lower = reply.toLowerCase();
    if (/^(retry|try again|again|same|same handle)\b/.test(lower) && brand.igHandle) {
      const outcome = await probeAndAnalyzeOrAskWebsite(brandId, brand.igHandle, channel);
      if (outcome === 'awaiting_website') {
        ctx.suspend({ question: 'website' });
      }
      ctx.suspend({ question: 'brand_kit_review', mode: outcome });
    }
    const newHandle = await extractHandleWithLLM(reply);
    if (!newHandle) {
      await channel.sendText(
        await phraseAsDuffy({
          goal: "Generic: you couldn't read that account, ask them to send the handle again (without the @) and you'll retry.",
          mustConvey:
            "You couldn't read that account. Ask them to send the handle again (without the @) and you'll retry.",
          brandId,
          fallback: RETRY_HANDLE_PROMPT,
        }),
      );
      ctx.suspend({ question: 'brand_kit_review', mode: 'retry_handle' });
    }
    const validatedHandle = newHandle as string;
    await updateBrand(brandId, {
      igHandle: validatedHandle,
      websiteUrl: null,
      awaitingWebsiteReply: false,
    });
    const outcome = await probeAndAnalyzeOrAskWebsite(brandId, validatedHandle, channel);
    if (outcome === 'awaiting_website') {
      ctx.suspend({ question: 'website' });
    }
    ctx.suspend({ question: 'brand_kit_review', mode: outcome });
  }

  // Sub-state 3: brand kit exists — user is reviewing it. One LLM call
  // disambiguates approve / new_handle / edit / unclear.
  const intent = await classifyReviewIntent(reply, { currentHandle: brand.igHandle });

  if (intent.intent === 'approve') {
    return { status: 'done' };
  }

  if (intent.intent === 'new_handle') {
    await updateBrand(brandId, {
      igHandle: intent.handle,
      brandKitJson: null,
      designSystemJson: null,
      voiceJson: null,
      igAnalysisJson: null,
      websiteUrl: null,
      awaitingWebsiteReply: false,
    });
    const outcome = await probeAndAnalyzeOrAskWebsite(brandId, intent.handle, channel);
    if (outcome === 'awaiting_website') {
      ctx.suspend({ question: 'website' });
    }
    ctx.suspend({ question: 'brand_kit_review', mode: outcome });
  }

  if (intent.intent === 'unclear') {
    await channel.sendText(
      await phraseAsDuffy({
        goal: "The user's reply during brand-kit review didn't clearly mean approve, a new handle, or a tweak. Ask them to clarify in one short line: lock it in, send a different handle, or tell you what to change.",
        mustConvey:
          'You did not understand whether they want to approve, try a different handle, or tweak the kit. Ask them to clarify.',
        brandId,
        context: { igHandle: brand.igHandle, userMessage: reply },
        fallback:
          "Sorry, I didn't quite catch that — reply YES to lock it in, send a different handle to try, or tell me what to tweak.",
      }),
    );
    ctx.suspend({ question: 'brand_kit_review', mode: 'reviewing' });
  }

  // intent.intent === 'edit' → let Duffy apply the change. The classifier's
  // editSummary is a clean paraphrase; fall back to the raw reply if absent.
  //
  // Defense in depth: the classifier prompt biases toward "edit" when in
  // doubt, so emphatic-but-shapeless approvals can land here with an
  // editSummary that itself reads like a yes ("yes", "lock it in"). In that
  // case we'd hand Duffy a non-existent tweak to apply, and she'd narrate
  // her confusion at the user. Treat it as approval instead.
  if (isExplicitApproval(intent.editSummary)) {
    logger.info(
      { brandId, reply, editSummary: intent.editSummary },
      'Brand kit edit intent has an approval-shaped editSummary; upgrading to approve',
    );
    return { status: 'done' };
  }

  // Voice contract: Duffy is the customer-facing point of contact. The
  // prompt here MUST NOT include developer plumbing (brandId tags, tool
  // names, field labels) because the orchestrator model occasionally
  // narrates back whatever it reads. Tool/brand context already lives in
  // the memory thread we pass via `memoryFor(brandId)`. After the call we
  // sanitize the output and fall back to `phraseAsDuffy` if Duffy leaked
  // her reasoning or returned nothing usable.
  await applyEditWithDuffy({
    brandId,
    igHandle: brand.igHandle,
    reply,
    editSummary: intent.editSummary,
    channel,
  });

  brand = (await findBrandById(brandId)) ?? brand;
  await presentBrandKitToUser(brand, channel, { force: true });
  ctx.suspend({ question: 'brand_kit_review', mode: 'reviewing' });
}

export const brandKitStep: OnboardingStep = {
  id: 'brand_kit',
  displayName: 'Brand kit',
  isComplete(brand) {
    // The kit is only "done" once the user has explicitly approved it. We
    // don't have a dedicated approved flag, but the review-loop in
    // executeBrandKit only returns `{ status: 'done' }` on approval, and the
    // workflow's progression past this step is the actual record of
    // approval. So idempotency here is conservative: only consider this step
    // complete if the brand has moved beyond `onboarding` (e.g. the timezone
    // step set it to `active`) AND a kit exists.
    return brand.brandKitJson !== null && brand.status !== 'pending' && brand.status !== 'onboarding';
  },
  execute: executeBrandKit,
};
