import { encodeMessage, type MessageData } from '@nowhere/codec';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createMessageTipInvoice, listMessageTipMethods } from '../../src/lib/message-tips.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeMessage(): string {
  const data: MessageData = {
    version: 1,
    siteType: 'message',
    name: 'Signal Boost',
    description: 'Support the courier.',
    tags: [
      { key: 'l', value: 'tips@seller.test,*PayPal:paypal.me/message,*!BTC:bc1qmessage' },
    ],
  };

  return encodeMessage(data).fragment;
}

function mockLightningFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === 'https://seller.test/.well-known/lnurlp/tips') {
      return new Response(JSON.stringify({
        callback: 'https://seller.test/lnurl/callback',
        minSendable: 1_000,
        maxSendable: 100_000_000,
        metadata: '[]',
        tag: 'payRequest',
      }), { status: 200 });
    }
    if (url.startsWith('https://seller.test/lnurl/callback')) {
      const amount = new URL(url).searchParams.get('amount');
      return new Response(JSON.stringify({
        pr: `lnbc-message-${amount}`,
        routes: [],
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL in message tip test: ${url}`);
  }));
}

describe('message tip helpers', () => {
  test('lists tip methods with stable ids', async () => {
    const methods = await listMessageTipMethods(makeMessage());

    expect(methods).toHaveLength(3);
    expect(methods[0]?.id).toBe('lightning');
    expect(methods[0]?.type).toBe('lightning');
    expect(methods[1]?.id).toBe('custom_0');
    expect(methods[1]?.label).toBe('PayPal');
    expect(methods[2]?.id).toBe('custom_1');
    expect(methods[2]?.showQr).toBe(true);
  });

  test('creates message lightning invoices and rejects custom methods for invoice generation', async () => {
    mockLightningFetch();

    const invoice = await createMessageTipInvoice({
      messageInput: makeMessage(),
      sats: 2_100,
    });

    expect(invoice.method.id).toBe('lightning');
    expect(invoice.invoice).toBe('lnbc-message-2100000');

    await expect(createMessageTipInvoice({
      messageInput: makeMessage(),
      methodId: 'custom_0',
      sats: 2_100,
    })).rejects.toThrow(/does not support invoice generation/i);
  });
});
