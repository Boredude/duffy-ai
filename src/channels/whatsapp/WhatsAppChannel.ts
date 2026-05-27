import {
  sendButtons as kapsoSendButtons,
  sendImage as kapsoSendImage,
  sendImageWithButtons as kapsoSendImageWithButtons,
  sendText as kapsoSendText,
  sendTypingIndicator as kapsoSendTypingIndicator,
} from '../../services/kapso/client.js';
import type {
  BoundChannel,
  Channel,
  ChannelButton,
  ChannelCapabilities,
  SendButtonsArgs,
  SendImageWithButtonsArgs,
} from '../types.js';

const WA_CAPABILITIES: ChannelCapabilities = {
  supportsText: true,
  supportsImages: true,
  supportsButtons: true,
  supportsImageWithButtons: true,
  // Meta caps interactive messages at 3 reply buttons.
  maxButtonCount: 3,
  // WhatsApp text body cap is 4096; we leave headroom.
  maxBodyChars: 4000,
};

function toKapsoButtons(buttons: ChannelButton[]): { type: 'reply'; reply: { id: string; title: string } }[] {
  return buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } }));
}

class WhatsAppBoundChannel implements BoundChannel {
  readonly kind = 'whatsapp' as const;
  readonly capabilities = WA_CAPABILITIES;

  constructor(public readonly externalUserId: string) {}

  async sendText(body: string): Promise<void> {
    await kapsoSendText(this.externalUserId, body);
  }

  async sendImage(imageUrl: string, caption?: string): Promise<void> {
    await kapsoSendImage(this.externalUserId, imageUrl, caption);
  }

  async sendButtons(args: SendButtonsArgs): Promise<void> {
    await kapsoSendButtons({
      to: this.externalUserId,
      bodyText: args.bodyText,
      ...(args.footer ? { footer: args.footer } : {}),
      buttons: toKapsoButtons(args.buttons),
    });
  }

  async sendTyping(messageId: string): Promise<void> {
    await kapsoSendTypingIndicator(messageId);
  }

  async sendImageWithButtons(args: SendImageWithButtonsArgs): Promise<void> {
    await kapsoSendImageWithButtons({
      to: this.externalUserId,
      imageUrl: args.imageUrl,
      bodyText: args.bodyText,
      ...(args.footer ? { footer: args.footer } : {}),
      buttons: toKapsoButtons(args.buttons),
    });
  }
}

class WhatsAppChannelImpl implements Channel {
  readonly kind = 'whatsapp' as const;
  readonly capabilities = WA_CAPABILITIES;

  bind(externalUserId: string): BoundChannel {
    return new WhatsAppBoundChannel(externalUserId);
  }
}

let singleton: WhatsAppChannelImpl | null = null;

export function whatsAppChannel(): Channel {
  if (!singleton) singleton = new WhatsAppChannelImpl();
  return singleton;
}
