import { vi, type Mock } from 'vitest';
import type {
  BoundChannel,
  Channel,
  ChannelCapabilities,
  SendButtonsArgs,
  SendImageWithButtonsArgs,
} from '../../src/channels/types.js';

export type MockBoundChannel = BoundChannel & {
  sendText: Mock<(body: string) => Promise<void>>;
  sendImage: Mock<(imageUrl: string, caption?: string) => Promise<void>>;
  sendButtons: Mock<(args: SendButtonsArgs) => Promise<void>>;
  sendImageWithButtons: Mock<(args: SendImageWithButtonsArgs) => Promise<void>>;
  sendTyping: Mock<(messageId: string) => Promise<void>>;
};

const FULL_CAPS: ChannelCapabilities = {
  supportsText: true,
  supportsImages: true,
  supportsButtons: true,
  supportsImageWithButtons: true,
  maxButtonCount: 3,
  maxBodyChars: 4000,
};

/**
 * Builds a `BoundChannel` whose `send*` methods are vitest mocks. Use in
 * tests that exercise code which writes to a channel and you want to assert
 * what was sent.
 */
export function makeMockBoundChannel(
  externalUserId = '15558889999',
  capabilities: ChannelCapabilities = FULL_CAPS,
): MockBoundChannel {
  return {
    kind: 'whatsapp',
    externalUserId,
    capabilities,
    sendText: vi.fn(async (_body: string) => undefined),
    sendImage: vi.fn(async (_imageUrl: string, _caption?: string) => undefined),
    sendButtons: vi.fn(async (_args: SendButtonsArgs) => undefined),
    sendImageWithButtons: vi.fn(async (_args: SendImageWithButtonsArgs) => undefined),
    sendTyping: vi.fn(async (_messageId: string) => undefined),
  };
}

export function makeMockChannel(
  bound: MockBoundChannel = makeMockBoundChannel(),
): { channel: Channel; bound: MockBoundChannel } {
  const channel: Channel = {
    kind: 'whatsapp',
    capabilities: bound.capabilities,
    bind: vi.fn(() => bound),
  };
  return { channel, bound };
}
