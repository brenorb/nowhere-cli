import { encode, type StoreData } from '@nowhere/codec';
import { describe, expect, test } from 'vitest';
import type { Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import {
  NOWHERE_APPLICATION_KIND,
  NOWHERE_DTAG_PREFIX,
  NOWHERE_T_TAG,
  computeLookupHash,
  decryptOrderReceipt,
  fetchCurrentStatus,
  fetchOrdersForSeller,
  publishOrderReceipt,
  publishStoreStatus,
  type StatusPayload,
  type StoreRelayClient,
} from '../../src/lib/store-live.js';

class MemoryRelayClient implements StoreRelayClient {
  private readonly eventsByRelay = new Map<string, Event[]>();

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

    if (filter.limit !== undefined) {
      return events.slice(0, filter.limit);
    }

    return events;
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

function buildStoreUrl(pubkey: string, name = 'Freedom Market'): string {
  const store: StoreData = {
    version: 1,
    pubkey,
    name,
    description: 'Peer-to-peer goods.',
    tags: [
      { key: 'k', value: '1' },
      { key: '1', value: 'wss://inventory.example' },
      { key: '2', value: 'wss://orders.example,wss://orders-backup.example' },
    ],
    items: [
      { name: 'Sticker Pack', price: 750, tags: [] },
      { name: 'Poster', price: 2500, tags: [] },
    ],
  };

  return `https://hostednowhere.com/s#${encode(store).fragment}`;
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
});
