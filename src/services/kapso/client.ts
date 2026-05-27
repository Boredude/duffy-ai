import { loadEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type {
  KapsoOutboundMessage,
  KapsoReadReceipt,
  KapsoSendResponse,
  KapsoInteractiveButton,
} from './types.js';

const API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';

export class KapsoError extends Error {
  override readonly name = 'KapsoError';
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function send(message: KapsoOutboundMessage): Promise<KapsoSendResponse> {
  const env = loadEnv();
  const url = `${API_BASE}/${env.KAPSO_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': env.KAPSO_API_KEY,
    },
    body: JSON.stringify(message),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.error({ status: res.status, body }, 'Kapso send failed');
    throw new KapsoError(`Kapso send failed: ${res.status}`, res.status, body);
  }
  return body as KapsoSendResponse;
}

export async function sendText(to: string, body: string): Promise<KapsoSendResponse> {
  return send({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body, preview_url: false },
  });
}

export async function sendImage(
  to: string,
  link: string,
  caption?: string,
): Promise<KapsoSendResponse> {
  return send({
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: caption ? { link, caption } : { link },
  });
}

/**
 * Sends an image preview with up to 3 reply buttons (WhatsApp limit).
 * Used for the post-draft approval flow with payloads like
 * `approve_<draftId>` / `edit_<draftId>` / `reject_<draftId>`.
 */
export async function sendImageWithButtons(args: {
  to: string;
  imageUrl: string;
  bodyText: string;
  footer?: string;
  buttons: KapsoInteractiveButton[];
}): Promise<KapsoSendResponse> {
  if (args.buttons.length === 0 || args.buttons.length > 3) {
    throw new KapsoError(`WhatsApp interactive messages support 1-3 buttons (got ${args.buttons.length})`);
  }
  return send({
    messaging_product: 'whatsapp',
    to: args.to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'image', image: { link: args.imageUrl } },
      body: { text: args.bodyText },
      ...(args.footer ? { footer: { text: args.footer } } : {}),
      action: { buttons: args.buttons },
    },
  });
}

export async function sendTypingIndicator(messageId: string): Promise<void> {
  const env = loadEnv();
  const url = `${API_BASE}/${env.KAPSO_PHONE_NUMBER_ID}/messages`;
  const body: KapsoReadReceipt = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  };
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': env.KAPSO_API_KEY },
    body: JSON.stringify(body),
  }).catch((err) => logger.warn({ err, messageId }, 'sendTypingIndicator failed'));
}

export async function sendButtons(args: {
  to: string;
  bodyText: string;
  footer?: string;
  buttons: KapsoInteractiveButton[];
}): Promise<KapsoSendResponse> {
  if (args.buttons.length === 0 || args.buttons.length > 3) {
    throw new KapsoError(`WhatsApp interactive messages support 1-3 buttons (got ${args.buttons.length})`);
  }
  return send({
    messaging_product: 'whatsapp',
    to: args.to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: args.bodyText },
      ...(args.footer ? { footer: { text: args.footer } } : {}),
      action: { buttons: args.buttons },
    },
  });
}
