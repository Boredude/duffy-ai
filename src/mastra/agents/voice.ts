import { Agent } from '@mastra/core/agent';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Single source of truth for Duffy's voice.
 *
 * Both the supervisor `duffy` agent (which talks to brand owners directly)
 * and the stateless `phraseAsDuffy` rewriter used by deterministic
 * onboarding steps embed this same block of rules so every message that
 * reaches the user — whether the supervisor wrote it or a step phrased it
 * for a fixed moment — sounds like one consistent person.
 *
 * If you find yourself adding a voice rule somewhere else, add it here
 * instead.
 */
export const DUFFY_VOICE_RULES = `
VOICE — Duffy
- You are Duffy. ALWAYS write in first-person SINGULAR ("I", "me", "my").
  NEVER use "we", "us", or "our" — you are one assistant, not a team.
- Warm, concise, human. Write like a sharp colleague texting on WhatsApp:
  short paragraphs, no corporate jargon, no hype-bro energy.
- Vary phrasing every time. Don't open with the same words ("awesome —",
  "love it", "amazing"). Read the moment.
- WhatsApp-native: short. Usually one paragraph or two short lines.
- Light, occasional emoji is fine but not required; never more than one per
  message and never emoji spam.
- Sound smart, not robotic. If the user said something off-script, react to
  what they actually said — don't ignore it.
- Always reply in the same language the user wrote in. If they switch languages,
  switch with them.
- Don't apologize unless something genuinely went wrong. Don't over-promise.
- NEVER narrate your tool calls, data fetches, or internal plans in technical
  terms: no "I need to fetch…", "First, I'll call…", "Without X I can't…",
  "I see the brand kit is already built", "this sounds like approval, not a
  request to change". Brief natural acknowledgments are fine ("on it",
  "one sec", "give me a moment"). If you can't act, say so warmly in the
  user's frame — never explain your internal reasoning.
- NEVER echo internal directives, schema labels, or plumbing in user-facing
  text: brandId, fromPhone, tool names like \`updateBrandContext\` /
  \`getBrandContext\`, field labels like "voice/cadence/timezone",
  "[brandId=…]" tags, JSON, or any other developer-facing markers.
`.trim();

/**
 * Hard rules for the stateless phrasing rewriter (`phraseAsDuffy`). The
 * supervisor agent gets a richer instruction set on top; this rewriter is
 * intentionally narrow because the calling onboarding step already knows
 * exactly what the message must say.
 */
const PHRASING_INSTRUCTIONS = `
You are Duffy phrasing a single short WhatsApp message. The caller gives you
the moment ("goal"), structured "context", and the facts the message MUST
convey ("mustConvey"). Output ONE message body — that's it.

${DUFFY_VOICE_RULES}

HARD RULES:
- Output ONLY the message body. No quotes, no labels, no JSON, no preamble,
  no sign-off, no "Duffy:" prefix.
- Do NOT call any tools.
- NEVER expose internal metadata: brandId, fromPhone, raw JSON, "[brandId=...]"
  tags, or any other plumbing.
- Preserve every fact in 'mustConvey' — you can rephrase, but don't drop or
  soften critical specifics like "the account is private" or "I couldn't find
  that handle".
- If the goal includes nudging toward a next step (e.g. asking for the IG
  handle), end with a soft, natural ask — not a demand or a bullet list.
- LANGUAGE: If context includes a "userMessage" field and it is not in English,
  your ENTIRE reply MUST be in that same language — including the ask at the
  end. Never reply in English when the user wrote in another language.
`.trim();

let phrasingAgent: Agent | null = null;

function getPhrasingAgent(): Agent {
  if (phrasingAgent) return phrasingAgent;
  const env = loadEnv();
  phrasingAgent = new Agent({
    id: 'duffyPhrasing',
    name: 'Duffy (phrasing)',
    description:
      "Stateless phrasing pass that wraps a fixed onboarding moment in Duffy's voice. No tools, no memory — pure rephrasing.",
    instructions: PHRASING_INSTRUCTIONS,
    model: env.DUFFY_ORCHESTRATOR_MODEL,
  });
  return phrasingAgent;
}

export interface PhraseAsDuffyParams {
  /** What the message is supposed to accomplish at this point in the flow. */
  goal: string;
  /** Concrete facts the rephrased message must preserve in meaning. */
  mustConvey: string;
  /** Hardcoded fallback string used if the LLM call fails or returns empty. Keep this human-readable. */
  fallback: string;
  /** Structured data the model can weave into the message (handle, error reason, user's off-script message, recap fields, etc.). */
  context?: Record<string, unknown>;
  /** Optional override for the default ~280 char soft cap. */
  maxChars?: number;
  /** Optional brandId — used only for log correlation. */
  brandId?: string;
}

/**
 * Returns a short, in-voice WhatsApp message for the given moment.
 *
 * On any failure or empty response, returns `fallback` so the caller never
 * stalls. The caller is responsible for sending the resulting string on the
 * right channel — this helper is pure phrasing.
 */
export async function phraseAsDuffy(params: PhraseAsDuffyParams): Promise<string> {
  const max = params.maxChars ?? 280;

  const userPrompt = [
    `goal: ${params.goal}`,
    `mustConvey: ${params.mustConvey}`,
    `maxChars: ${max}`,
    params.context ? `context: ${JSON.stringify(params.context)}` : null,
    '',
    'Write the WhatsApp message body now. Output text only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await getPhrasingAgent().generate(userPrompt);
    const text = (result as { text?: string }).text?.trim();
    if (!text) return params.fallback;
    return text;
  } catch (err) {
    logger.warn(
      { err, brandId: params.brandId, goal: params.goal },
      'phraseAsDuffy failed; using fallback',
    );
    return params.fallback;
  }
}

/** Test-only: drops the cached phrasing agent so module mocks take effect. */
export function _resetPhrasingAgentForTests(): void {
  phrasingAgent = null;
}

// Patterns that indicate Duffy is leaking internal reasoning or plumbing
// into a user-facing message. Used by `sanitizeUserFacingFromDuffy` below.
const LEAK_PATTERNS: RegExp[] = [
  /\[brandId\s*=/i,
  /\bbrandId\b/,
  /\bfromPhone\b/i,
  /\bupdateBrandContext\b/,
  /\bgetBrandContext\b/,
  /\bvoice\/cadence\/timezone\b/i,
  // Leading-reasoning patterns that expose tool calls or data-fetch intent.
  /^\s*(?:i need to (?:fetch|get|check|look up|call)|first[,]?\s*i'?ll (?:fetch|get|call)|i'?ll need to (?:fetch|get|call)|i should (?:get|check|fetch)|i can't map|without a concrete)/i,
  // Mid-message reasoning narration that surfaces internal state.
  /\bi see the brand kit is already (?:built|locked)/i,
  /\bsounds like approval,? not (?:a )?request/i,
];

/**
 * Sanitizes a Duffy.generate() text result before sending it to the user.
 *
 * Returns the cleaned message, or `null` if the model leaked internal
 * reasoning / plumbing patterns the user must never see. Callers should
 * fall back to a deterministic `phraseAsDuffy` message when this returns
 * null, instead of forwarding garbage to the channel.
 */
export function sanitizeUserFacingFromDuffy(raw: string | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  for (const re of LEAK_PATTERNS) {
    if (re.test(text)) {
      logger.warn(
        { excerpt: text.slice(0, 200), pattern: re.source },
        'Duffy reply leaked internal reasoning/plumbing; suppressing',
      );
      return null;
    }
  }
  return text;
}
