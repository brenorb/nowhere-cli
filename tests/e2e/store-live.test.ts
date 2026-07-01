import { encode, type StoreData } from '@nowhere/codec';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import { beginStoreCheckout, quoteStoreCheckout } from '../../src/lib/store-checkout.js';
import {
  NOWHERE_APPLICATION_KIND,
  NOWHERE_DTAG_PREFIX,
  NOWHERE_T_TAG,
  computeLookupHash,
  decryptOrderReceipt,
  fetchCurrentStatus,
  fetchOrdersByIds,
  fetchOrdersForSeller,
  publishOrderReceipt,
  publishStoreStatus,
  verifyStoreOrderPayload,
  type StatusPayload,
  type StoreRelayClient,
} from '../../src/lib/store-live.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

class MemoryRelayClient implements StoreRelayClient {
  private readonly eventsByRelay = new Map<string, Event[]>();

  constructor(private readonly maxPerQuery?: number) {}

  async publish(event: Event, relays: string[]): Promise<void> {
    for (const relay of relays) {
      const bucket = this.eventsByRelay.get(relay) ?? [];
      const next = bucket.filter((candidate) => {
        if (candidate.kind !== event.kind || candidate.pubkey !== event.pubkey) {
          return true;
        }

        const dTag = candidate.tags.find((tag) => tag[0] === 'd')?.[1];
        const nextDTag = event.tags.find((tag) => tag[0] === 'd')?.[1];
        return dTag !== nextDTag;
      });
      next.push(event);
      this.eventsByRelay.set(relay, next);
    }
  }

  async fetchEvent(filter: Filter, relays: string[]): Promise<Event | null> {
    return this.filterEvents(filter, relays)[0] ?? null;
  }

  async fetchEvents(filter: Filter, relays: string[]): Promise<Event[]> {
    return this.filterEvents(filter, relays);
  }

  private filterEvents(filter: Filter, relays: string[]): Event[] {
    const seen = new Map<string, Event>();
    for (const relay of relays) {
      for (const event of this.eventsByRelay.get(relay) ?? []) {
        if (!matchesFilter(filter, event)) {
          continue;
        }
        const existing = seen.get(event.id);
        if (!existing || event.created_at > existing.created_at) {
          seen.set(event.id, event);
        }
      }
    }

    const events = [...seen.values()].sort((left, right) => {
      if (left.created_at !== right.created_at) {
        return right.created_at - left.created_at;
      }
      return right.id.localeCompare(left.id);
    });

    const limit = Math.min(
      filter.limit ?? Number.POSITIVE_INFINITY,
      this.maxPerQuery ?? Number.POSITIVE_INFINITY,
    );
    return Number.isFinite(limit) ? events.slice(0, limit) : events;
  }
}

function matchesFilter(filter: Filter, event: Event): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) {
    return false;
  }
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) {
      continue;
    }
    const tagName = key.slice(1);
    const filterValues = values as string[];
    const hasTag = event.tags.some(([tag, value]) => tag === tagName && filterValues.includes(value));
    if (!hasTag) {
      return false;
    }
  }

  return true;
}

function buildStoreUrl(
  pubkey: string,
  name = 'Freedom Market',
  options?: { tags?: StoreData['tags']; items?: StoreData['items'] },
): string {
  const store: StoreData = {
    version: 1,
    pubkey,
    name,
    description: 'Peer-to-peer goods.',
    tags: options?.tags ?? [
      { key: '$', value: 'USD' },
      { key: 'k', value: '1' },
      { key: '1', value: 'wss://inventory.example' },
      { key: '2', value: 'wss://orders.example,wss://orders-backup.example' },
    ],
    items: options?.items ?? [
      { name: 'Sticker Pack', price: 7.5, tags: [] },
      { name: 'Poster', price: 25, tags: [] },
    ],
  };

  return `https://hostednowhere.com/s#${encode(store).fragment}`;
}

function mockCheckoutFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);

    if (url.startsWith('https://api.coingecko.com/api/v3/simple/price')) {
      const currency = new URL(url).searchParams.get('vs_currencies');
      const pricePerBtc = currency === 'aud' ? 80_000 : 50_000;
      return new Response(JSON.stringify({ bitcoin: { [currency ?? 'usd']: pricePerBtc } }), { status: 200 });
    }

    if (url.startsWith('https://api.yadio.io/exrates/') || url.startsWith('https://api.kraken.com/0/public/Ticker')) {
      return new Response('upstream unavailable', { status: 500 });
    }

    if (url === 'https://tips@seller.test') {
      return new Response('not used', { status: 404 });
    }

    if (url === 'https://seller.test/.well-known/lnurlp/tips') {
      return new Response(JSON.stringify({
        callback: 'https://seller.test/lnurl/callback',
        minSendable: 1_000,
        maxSendable: 10_000_000_000,
        metadata: '[]',
        tag: 'payRequest',
      }), { status: 200 });
    }

    if (url.startsWith('https://seller.test/lnurl/callback')) {
      const amount = new URL(url).searchParams.get('amount');
      return new Response(JSON.stringify({
        pr: `lnbc-test-${amount}`,
        routes: [],
      }), { status: 200 });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  }));
}

describe('store-live runtime', () => {
  test('publishes order events and receipts, then fetches seller orders for a specific store', async () => {
    const relayClient = new MemoryRelayClient();
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Freedom Market');
    const otherStoreUrl = buildStoreUrl(seller.nowherePubkey, 'Second Market');
    const orderRelays = ['wss://orders.example', 'wss://orders-backup.example'];

    const published = await publishOrderReceipt(
      {
        storeUrl,
        relayList: orderRelays,
        items: [{ i: 0, qty: 2 }],
        subtotal: 1500,
        shipping: 500,
        total: 2000,
        buyer: {
          name: 'Alice',
          email: 'alice@nowhere.test',
          country: 'BR',
        },
        paymentMethod: 'lightning',
        paymentCurrency: 'USD',
        paymentAmount: 2000,
      },
      relayClient,
    );

    await publishOrderReceipt(
      {
        storeUrl: otherStoreUrl,
        relayList: orderRelays,
        items: [{ i: 1, qty: 1 }],
        subtotal: 2500,
        shipping: 0,
        total: 2500,
        buyer: {
          name: 'Bob',
          email: 'bob@nowhere.test',
        },
      },
      relayClient,
    );

    expect(published.event.kind).toBe(NOWHERE_APPLICATION_KIND);
    expect(published.event.tags).toContainEqual(['d', `${NOWHERE_DTAG_PREFIX}/${published.order.orderId}`]);
    expect(published.event.tags).toContainEqual(['t', NOWHERE_T_TAG]);

    const decryptedReceipt = decryptOrderReceipt(published.receipt, seller.nsec);
    expect(decryptedReceipt.order.orderId).toBe(published.order.orderId);
    expect(decryptedReceipt.order.buyer.email).toBe('alice@nowhere.test');

    const fetched = await fetchOrdersForSeller(
      {
        sellerSecret: seller.secretHex,
        storeUrl,
        relayList: orderRelays,
      },
      relayClient,
    );

    expect(fetched.failedEventIds).toEqual([]);
    expect(fetched.orders).toHaveLength(1);
    expect(fetched.orders[0]?.order.orderId).toBe(published.order.orderId);
    expect(fetched.orders[0]?.order.storeId).toBe(computeLookupHash(storeUrl.split('#')[1] ?? ''));
    expect(fetched.orders[0]?.order.buyer.name).toBe('Alice');
  });

  test('publishes store status payloads and fetches the current decrypted status', async () => {
    const relayClient = new MemoryRelayClient();
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Freedom Market');
    const status: StatusPayload = {
      v: 1,
      notice: 'Shipping on Fridays.',
      items: {
        '0': 2,
        '1': 1,
      },
      low: {
        warn: true,
        fields: 'email',
      },
    };

    const published = await publishStoreStatus(
      {
        storeUrl,
        sellerSecret: seller.nsec,
        payload: status,
      },
      relayClient,
    );

    expect(published.event.kind).toBe(NOWHERE_APPLICATION_KIND);
    expect(published.event.tags).toContainEqual([
      'd',
      `${NOWHERE_DTAG_PREFIX}/${computeLookupHash(storeUrl.split('#')[1] ?? '')}`,
    ]);
    expect(published.event.tags).toContainEqual(['t', NOWHERE_T_TAG]);
    expect(published.relays).toEqual(['wss://inventory.example']);

    const fetched = await fetchCurrentStatus(
      {
        storeUrl,
      },
      relayClient,
    );

    expect(fetched.payload).toEqual(status);
    expect(fetched.event?.pubkey).toBe(seller.pubkeyHex);
  });

  test('fetches specific seller orders by their order ids', async () => {
    const relayClient = new MemoryRelayClient();
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Freedom Market');
    const orderRelays = ['wss://orders.example', 'wss://orders-backup.example'];

    const first = await publishOrderReceipt(
      {
        storeUrl,
        relayList: orderRelays,
        items: [{ i: 0, qty: 1 }],
        subtotal: 750,
        shipping: 0,
        total: 750,
        buyer: { name: 'Alice' },
      },
      relayClient,
    );

    await publishOrderReceipt(
      {
        storeUrl,
        relayList: orderRelays,
        items: [{ i: 1, qty: 1 }],
        subtotal: 2500,
        shipping: 0,
        total: 2500,
        buyer: { name: 'Bob' },
      },
      relayClient,
    );

    const fetched = await fetchOrdersByIds(
      {
        storeUrl,
        sellerSecret: seller.secretHex,
        relayList: orderRelays,
        orderIds: [first.order.orderId],
      },
      relayClient,
    );

    expect(fetched.failedEventIds).toEqual([]);
    expect(fetched.orders).toHaveLength(1);
    expect(fetched.orders[0]?.order.orderId).toBe(first.order.orderId);
    expect(fetched.orders[0]?.order.buyer.name).toBe('Alice');
  });

  test('paginates seller order history when relay queries are capped', async () => {
    const relayClient = new MemoryRelayClient(2);
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Paged Market');
    const orderRelays = ['wss://orders.example'];
    const publishedIds: string[] = [];
    const nowSpy = vi.spyOn(Date, 'now');

    for (let index = 0; index < 5; index += 1) {
      nowSpy.mockReturnValue(1_720_000_000_000 + (index * 1_000));
      const published = await publishOrderReceipt(
        {
          storeUrl,
          relayList: orderRelays,
          items: [{ i: 0, qty: 1 }],
          subtotal: 1000 + index,
          shipping: 0,
          total: 1000 + index,
          buyer: { name: `Buyer ${index}` },
          timestamp: 1_720_000_000 + index,
        },
        relayClient,
      );
      publishedIds.push(published.order.orderId);
    }
    nowSpy.mockRestore();

    const fetched = await fetchOrdersForSeller(
      {
        storeUrl,
        sellerSecret: seller.secretHex,
        relayList: orderRelays,
      },
      relayClient,
    );
    expect(fetched.orders).toHaveLength(5);
    expect(fetched.orders.map((entry) => entry.order.orderId).sort()).toEqual([...publishedIds].sort());

    const byIds = await fetchOrdersByIds(
      {
        storeUrl,
        sellerSecret: seller.secretHex,
        relayList: orderRelays,
        orderIds: publishedIds,
      },
      relayClient,
    );
    expect(byIds.orders).toHaveLength(5);
    expect(byIds.orders.map((entry) => entry.order.orderId).sort()).toEqual([...publishedIds].sort());
  });

  test('verifies receipt payloads against the store with historical rate overrides', async () => {
    const relayClient = new MemoryRelayClient();
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Discount Market', {
      tags: [
        { key: '$', value: 'USD' },
        { key: '1', value: 'wss://inventory.example' },
        { key: '2', value: 'wss://orders.example,wss://orders-backup.example' },
        { key: 'B', value: '2:10' },
        { key: 's', value: '300' },
      ],
      items: [
        { name: 'Manual', price: 10, tags: [] },
      ],
    });

    const published = await publishOrderReceipt(
      {
        storeUrl,
        relayList: ['wss://orders.example'],
        items: [{ i: 0, qty: 2 }],
        subtotal: 1800,
        shipping: 300,
        total: 2100,
        buyer: { name: 'Alice' },
        paymentMethod: 'lightning',
        paymentCurrency: 'BTC',
        totalSats: 42000,
        timestamp: 1_700_000_000,
      },
      relayClient,
    );

    const verified = await verifyStoreOrderPayload({
      storeUrl,
      payload: published.receiptPayload,
      sellerSecret: seller.nsec,
      receivedSats: 42000,
      storeRateOverride: {
        satsPerUnit: 2000,
        source: 'test',
      },
    });

    expect(verified.source).toBe('receipt');
    expect(verified.ok).toBe(true);
    expect(verified.order.orderId).toBe(published.order.orderId);
    expect(verified.verification.expectedSubtotal).toBe(18);
    expect(verified.verification.expectedShipping).toBe(3);
    expect(verified.verification.expectedTotal).toBe(21);
    expect(verified.verification.expectedSats).toBe(42000);
    expect(verified.verification.subtotalMatch).toBe(true);
    expect(verified.verification.shippingMatch).toBe(true);
    expect(verified.verification.totalMatch).toBe(true);
  });

  test('quotes checkout requirements and begins lightning/manual checkout flows', async () => {
    mockCheckoutFetch();

    const relayClient = new MemoryRelayClient();
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Checkout Market', {
      tags: [
        { key: '$', value: 'USD' },
        { key: 'k', value: '1' },
        { key: '1', value: 'wss://inventory.example' },
        { key: '2', value: 'wss://orders.example' },
        { key: 'N', value: undefined },
        { key: 'A', value: undefined },
        { key: 'L', value: 'US' },
        { key: 'R', value: 'CA700' },
        { key: 'l', value: 'tips@seller.test' },
        { key: 'j', value: 'seller@payid.test' },
        { key: '5', value: '*USD:Wire:acct-123' },
      ],
      items: [
        { name: 'Archive Zine', price: 10, tags: [{ key: 'v', value: 'Small.Large' }] },
      ],
    });

    await publishStoreStatus({
      storeUrl,
      sellerSecret: seller.secretHex,
      payload: {
        v: 1,
        items: { '0': 2 },
        variants: { '0': { Small: 2, Large: 0 } },
        low: { warn: true, fields: 'email,notes', refund: true },
      },
    }, relayClient);

    const quote = await quoteStoreCheckout({
      storeUrl,
      items: [{ i: 0, qty: 1, v: 'Small' }],
      buyerCountry: 'CA',
    }, relayClient);

    expect(quote.inventory.gate).toBe('ok');
    expect(quote.shipping).toBe(7);
    expect(quote.total).toBe(17);
    expect(quote.fields.required).toEqual(expect.arrayContaining([
      'name',
      'email',
      'street',
      'city',
      'country',
      'notes',
      'refundAddress',
    ]));
    expect(quote.items[0]?.lowStock).toBe(true);
    expect(quote.items[0]?.unavailable).toBe(false);
    expect(quote.methods.map((entry) => entry.method.id)).toEqual(['bitcoin', 'payid', 'custom_0']);

    const lightning = await beginStoreCheckout({
      storeUrl,
      items: [{ i: 0, qty: 1, v: 'Small' }],
      buyer: {
        name: 'Alex',
        email: 'alex@example.com',
        street: '1 Relay Way',
        city: 'Toronto',
        country: 'CA',
        notes: 'Leave at door',
        refundAddress: 'lnbc-refund',
      },
      methodId: 'bitcoin',
    }, relayClient);

    expect(lightning.flow).toBe('lightning');
    expect(lightning.invoice).toBe('lnbc-test-34000000');
    expect(lightning.amountSats).toBe(34_000);
    expect(lightning.published.order.paymentMethod).toBe('bitcoin');

    const manual = await beginStoreCheckout({
      storeUrl,
      items: [{ i: 0, qty: 1, v: 'Small' }],
      buyer: {
        name: 'Blake',
        email: 'blake@example.com',
        street: '2 Relay Way',
        city: 'Toronto',
        country: 'CA',
        notes: 'Buzz on arrival',
        refundAddress: 'payid-refund',
      },
      methodId: 'payid',
    }, relayClient);

    expect(manual.flow).toBe('manual');
    expect(manual.paymentCurrency).toBe('AUD');
    expect(manual.instructions).toContain('seller@payid.test');
    expect(manual.instructions).toContain(manual.published.order.orderId);
    expect(manual.published.order.paymentMethod).toBe('payid');
    expect(manual.published.order.paymentCurrency).toBe('AUD');
  });
});
