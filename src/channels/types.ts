import type { ChannelKind } from '../db/schema.js';

export type { ChannelKind };

/**
 * What an inbound message decoder produces, normalized across channel
 * vendors. The dispatcher and all downstream code operate on this — never
 * on Kapso/Twilio/Telegram-specific shapes.
 *
 * `externalUserId` is the channel-native identifier for the sender (phone
 * for WhatsApp/SMS, telegram chat id, etc.) and is the lookup key in
 * `brand_channels`.
 */
export type ChannelMessageBase = {
  channelKind: ChannelKind;
  externalUserId: string;
  externalMessageId: string;
  contactName?: string;
  conversationId?: string;
};

export type ChannelMessage = ChannelMessageBase &
  (
    | { kind: 'text'; text: string }
    | {
        kind: 'button';
        buttonId: string;
        buttonTitle: string;
        decision?: 'approve' | 'edit' | 'reject';
        draftId?: string;
      }
    | {
        kind: 'image';
        mediaId: string;
        mimeType?: string;
        caption?: string;
        mediaLink?: string;
      }
    | { kind: 'unsupported'; rawType: string }
  );

/**
 * Static facts about what a channel can carry. Callers that build outbound
 * messages should consult these (e.g. fall back to numbered text replies on
 * channels with `supportsButtons: false`) rather than calling channel
 * methods that may not be supported.
 */
export type ChannelCapabilities = {
  supportsText: boolean;
  supportsImages: boolean;
  supportsButtons: boolean;
  supportsImageWithButtons: boolean;
  /** Maximum number of reply buttons in one interactive message. */
  maxButtonCount: number;
  /** Soft limit on body characters before we should split or truncate. */
  maxBodyChars: number;
};

export type ChannelButton = {
  id: string;
  title: string;
};

export type SendButtonsArgs = {
  bodyText: string;
  footer?: string;
  buttons: ChannelButton[];
};

export type SendImageWithButtonsArgs = SendButtonsArgs & {
  imageUrl: string;
};

/**
 * Channel adapter not yet bound to a recipient. Implementations are
 * singletons (one per kind). Use `bind(externalUserId)` to get a
 * recipient-bound handle for actual sends.
 */
export interface Channel {
  readonly kind: ChannelKind;
  readonly capabilities: ChannelCapabilities;
  bind(externalUserId: string): BoundChannel;
}

/**
 * A `Channel` with a recipient pre-bound. All `send*` methods send to the
 * same `externalUserId`. This is what most callers actually take —
 * pre-binding eliminates a class of "sent to the wrong user" bugs.
 */
export interface BoundChannel {
  readonly kind: ChannelKind;
  readonly externalUserId: string;
  readonly capabilities: ChannelCapabilities;
  sendText(body: string): Promise<void>;
  sendImage(imageUrl: string, caption?: string): Promise<void>;
  sendButtons(args: SendButtonsArgs): Promise<void>;
  sendImageWithButtons(args: SendImageWithButtonsArgs): Promise<void>;
  sendTyping(messageId: string): Promise<void>;
}
