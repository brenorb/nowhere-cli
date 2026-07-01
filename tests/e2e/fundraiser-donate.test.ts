import { encodeFundraiser, type FundraiserData } from '@nowhere/codec';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createFundraiserDonationInvoice, listFundraiserDonationMethods } from '../../src/lib/fundraiser-donate.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeFundraiser(): string {
  const data: FundraiserData = {
    version: 1,
    siteType: 'fundraiser',
    name: 'Freedom Fund',
    description: 'Peer-to-peer campaign.',
    tags: [
      { key: 'l', value: 'tips@seller.test,*PayPal:paypal.me/freedom,*!BTC:bc1qfundraiser' },
    ],
  };

  return encodeFundraiser(data).fragment;
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
        pr: `lnbc-fundraiser-${amount}`,
        routes: [],
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL in fundraiser test: ${url}`);
  }));
}

describe('fundraiser donation helpers', () => {
  test('lists donation methods with stable ids', async () => {
    const methods = await listFundraiserDonationMethods(makeFundraiser());

    expect(methods).toHaveLength(3);
    expect(methods[0]?.id).toBe('lightning');
    expect(methods[0]?.type).toBe('lightning');
    expect(methods[1]?.id).toBe('custom_0');
    expect(methods[1]?.label).toBe('PayPal');
    expect(methods[2]?.id).toBe('custom_1');
    expect(methods[2]?.showQr).toBe(true);
  });

  test('creates fundraiser lightning invoices and rejects custom methods for invoice generation', async () => {
    mockLightningFetch();

    const invoice = await createFundraiserDonationInvoice({
      fundraiserInput: makeFundraiser(),
      sats: 5_000,
    });

    expect(invoice.method.id).toBe('lightning');
    expect(invoice.invoice).toBe('lnbc-fundraiser-5000000');

    await expect(createFundraiserDonationInvoice({
      fundraiserInput: makeFundraiser(),
      methodId: 'custom_0',
      sats: 5_000,
    })).rejects.toThrow(/does not support invoice generation/i);
  });
});
