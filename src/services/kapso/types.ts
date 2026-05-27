/**
 * Minimal Kapso WhatsApp API types covering only what Duffy uses today.
 * Reference: https://docs.kapso.ai/api/meta/whatsapp/messages/send-a-message
 */

export type KapsoOutboundText = {
  messaging_product: 'whatsapp';
  recipient_type?: 'individual';
  to: string;
  type: 'text';
  text: { body: string; preview_url?: boolean };
};

export type KapsoOutboundImage = {
  messaging_product: 'whatsapp';
  to: string;
  type: 'image';
  image: { link: string; caption?: string };
};

export type KapsoInteractiveButton = {
  type: 'reply';
  reply: { id: string; title: string };
};

export type KapsoOutboundInteractive = {
  messaging_product: 'whatsapp';
  to: string;
  type: 'interactive';
  interactive: {
    type: 'button';
    header?: { type: 'image' | 'text'; image?: { link: string }; text?: string };
    body: { text: string };
    footer?: { text: string };
    action: { buttons: KapsoInteractiveButton[] };
  };
};

export type KapsoOutboundMessage =
  | KapsoOutboundText
  | KapsoOutboundImage
  | KapsoOutboundInteractive;

export type KapsoReadReceipt = {
  messaging_product: 'whatsapp';
  status: 'read';
  message_id: string;
  typing_indicator?: { type: 'text' };
};

export type KapsoSendResponse = {
  messaging_product: 'whatsapp';
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
};

// ---- Inbound webhook event shapes (Kapso "kapso" payload format) ----
// We model only what we need; everything else is preserved as `unknown`.

export type KapsoInboundTextMessage = {
  type: 'text';
  text: { body: string };
};

export type KapsoInboundButtonReply = {
  type: 'interactive';
  interactive: {
    type: 'button_reply';
    button_reply: { id: string; title: string };
  };
};

export type KapsoInboundImageMessage = {
  type: 'image';
  image: { id: string; mime_type?: string; caption?: string; link?: string };
};

export type KapsoInboundMessageBody =
  | KapsoInboundTextMessage
  | KapsoInboundButtonReply
  | KapsoInboundImageMessage
  | { type: string; [k: string]: unknown };

/**
 * Kapso webhook payload for `whatsapp.message.received` events.
 *
 * Kapso sends a flat structure with `message`, `conversation`, `phone_number_id`
 * at the top level. The event type is communicated via the `X-Webhook-Event`
 * HTTP header, NOT a body field.
 */
export type KapsoMessageReceivedEvent = {
  message: {
    id: string;
    from: string;
    timestamp?: string;
    to?: string;
    phone_number_id?: string;
    /** Kapso-specific metadata sub-object, e.g. { origin: 'cloud_api' }. */
    kapso?: Record<string, unknown>;
  } & KapsoInboundMessageBody;
  conversation?: {
    id?: string;
    contact_name?: string;
    phone_number?: string;
    phone_number_id?: string;
    [k: string]: unknown;
  };
  phone_number_id?: string;
  is_new_conversation?: boolean;
};
