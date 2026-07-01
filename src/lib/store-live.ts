import { base64urlToHex, type Tag } from '@nowhere/codec';
import { createHash, createHmac } from 'node:crypto';
import { Filter } from 'nostr-tools/filter';
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { type Event, finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { normalizeToFragment, resolveSiteInput } from './fragments.js';
import { parseSecretKeyInput } from './keys.js';

export const NOWHERE_APPLICATION_KIND = 30078;
export const NOWHERE_DTAG_PREFIX = 'nowhr';
export const NOWHERE_T_TAG = 'nowhr';

export const DEFAULT_INVENTORY_RELAYS = ['wss://relay.damus.io', 'wss://nostr.mom'];
export const DEFAULT_ORDER_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub'];

export type StockLevel = 0 | 1 | 2 | 3;

export interface StatusPayload {
  v: 1;
  notice?: string;
  closed?: string;
  redirect?: string;
  items?: Record<string, StockLevel>;
  variants?: Record<string, Record<string, StockLevel>>;
  low?: { warn?: boolean; fields?: string; refund?: boolean };
}

export interface OrderItem {
  i: number;
  qty: number;
  v?: string;
}

export interface OrderMessage {
  version: 1;
  orderId: string;
  timestamp: number;
  storeId: string;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  total: number;
  totalSats?: number;
  exchangeRate?: number;
  rateSource?: string;
  buyer: Record<string, string>;
  paymentMethod?: string;
  paymentCurrency?: string;
  paymentAmount?: number;
}

export interface OrderReceipt {
  v: 1;
  p: string;
  c: string;
}

export interface StoreRelayClient {
  publish(event: Event, relays: string[], label: string): Promise<void>;
  fetchEvent(filter: Filter, relays: string[]): Promise<Event | null>;
  fetchEvents(filter: Filter, relays: string[]): Promise<Event[]>;
}

export interface StoreLiveContext {
  storeUrl: string;
  storeFragment: string;
  lookupHash: string;
  sellerPubkeyHex: string;
  storeTags: Tag[];
}

export interface PublishOrderInput {
  storeUrl: string;
  buyer: Record<string, string>;
  items: OrderItem[];
  subtotal: number;
  shipping: number;
  total: number;
  totalSats?: number;
  exchangeRate?: number;
  rateSource?: string;
  paymentMethod?: string;
  paymentCurrency?: string;
  paymentAmount?: number;
  orderId?: string;
  timestamp?: number;
  relayList?: string[];
}

export interface PublishedOrder {
  context: StoreLiveContext;
  relays: string[];
  order: OrderMessage;
  event: VerifiedEvent;
  receipt: string;
  receiptPayload: OrderReceipt;
}

export interface DecryptedOrder {
  event: Event;
  order: OrderMessage;
}

export interface FetchOrdersInput {
  storeUrl: string;
  sellerSecret: string | Uint8Array;
  relayList?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

export interface FetchedOrders {
  context: StoreLiveContext;
  relays: string[];
  orders: DecryptedOrder[];
  failedEventIds: string[];
}

export interface PublishStatusInput {
  storeUrl: string;
  sellerSecret: string | Uint8Array;
  payload: StatusPayload;
  relayList?: string[];
  createdAt?: number;
}

export interface PublishedStatus {
  context: StoreLiveContext;
  relays: string[];
  event: VerifiedEvent;
  payload: StatusPayload;
}

export interface FetchStatusInput {
  storeUrl: string;
  relayList?: string[];
}

export interface FetchedStatus {
  context: StoreLiveContext;
  relays: string[];
  event: Event | null;
  payload: StatusPayload | null;
}

function normalizeSecret(secret: string | Uint8Array): Uint8Array {
  return typeof secret === 'string' ? parseSecretKeyInput(secret) : secret;
}

function uniqueRelays(relays: string[]): string[] {
  return Array.from(new Set(relays.map((relay) => relay.trim()).filter(Boolean)));
}

function resolveRelayList(override: string[] | undefined, fallback: string[]): string[] {
  const relays = uniqueRelays(override ?? fallback);
  if (relays.length === 0) {
    throw new Error('At least one relay is required.');
  }
  return relays;
}

function getTagRelays(tags: Tag[], key: string): string[] {
  const tag = tags.find((entry) => entry.key === key);
  if (!tag?.value) {
    return [];
  }
  return uniqueRelays(tag.value.split(','));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEvent(value: unknown): value is Event {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.pubkey === 'string' &&
    typeof value.created_at === 'number' &&
    typeof value.kind === 'number' &&
    Array.isArray(value.tags) &&
    typeof value.content === 'string' &&
    typeof value.sig === 'string'
  );
}

function isOrderMessage(value: unknown): value is OrderMessage {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.orderId === 'string' &&
    typeof value.timestamp === 'number' &&
    typeof value.storeId === 'string' &&
    Array.isArray(value.items) &&
    typeof value.subtotal === 'number' &&
    typeof value.shipping === 'number' &&
    typeof value.total === 'number' &&
    isRecord(value.buyer)
  );
}

function isStatusPayload(value: unknown): value is StatusPayload {
  return isRecord(value) && value.v === 1;
}

function sortEventsDescending(events: Event[]): Event[] {
  return [...events].sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return right.created_at - left.created_at;
    }
    return right.id.localeCompare(left.id);
  });
}

export function computeLookupHash(fragment: string): string {
  return createHash('sha256').update(fragment).digest('hex').slice(0, 15);
}

export function deriveInventoryKeypair(fragment: string): { privkey: Uint8Array; pubkey: string } {
  const privkey = createHmac('sha256', 'nowhere-inventory').update(fragment).digest();
  const secretKey = new Uint8Array(privkey);
  return {
    privkey: secretKey,
    pubkey: getPublicKey(secretKey),
  };
}

export function getInventoryRelays(storeTags: Tag[]): string[] {
  const tagged = getTagRelays(storeTags, '1');
  return tagged.length > 0 ? tagged : [...DEFAULT_INVENTORY_RELAYS];
}

export function getOrderRelays(storeTags: Tag[]): string[] {
  const tagged = getTagRelays(storeTags, '2');
  return tagged.length > 0 ? tagged : [...DEFAULT_ORDER_RELAYS];
}

export function generateOrderId(data: string): string {
  return createHash('sha256')
    .update(data + Date.now().toString())
    .digest('hex')
    .slice(0, 15);
}

export async function resolveStoreContext(storeUrl: string): Promise<StoreLiveContext> {
  const { fragment } = normalizeToFragment(storeUrl);
  const resolved = await resolveSiteInput(storeUrl);
  if (!resolved.siteData || resolved.siteData.siteType !== 'store') {
    throw new Error('Expected a Nowhere store URL or fragment.');
  }
  if (!resolved.siteData.pubkey) {
    throw new Error('Store is missing a seller pubkey.');
  }

  return {
    storeUrl,
    storeFragment: fragment,
    lookupHash: computeLookupHash(fragment),
    sellerPubkeyHex: base64urlToHex(resolved.siteData.pubkey),
    storeTags: resolved.siteData.tags,
  };
}

export function createSimplePoolRelayClient(pool = new SimplePool()): StoreRelayClient {
  return {
    async publish(event: Event, relays: string[], _label: string): Promise<void> {
      const targets = uniqueRelays(relays);
      const results = await Promise.allSettled(pool.publish(targets, event));
      const confirmed = results.filter(
        (result) => result.status === 'fulfilled' && !String(result.value).startsWith('connection failure'),
      );

      if (confirmed.length === 0) {
        const reasons = results.map((result) =>
          result.status === 'rejected' ? String(result.reason) : String(result.value),
        );
        throw new Error(`Failed to publish to any relay: ${reasons.join('; ')}`);
      }
    },
    async fetchEvent(filter: Filter, relays: string[]): Promise<Event | null> {
      return pool.get(uniqueRelays(relays), { ...filter, limit: filter.limit ?? 1 });
    },
    async fetchEvents(filter: Filter, relays: string[]): Promise<Event[]> {
      return pool.querySync(uniqueRelays(relays), filter);
    },
  };
}

export const defaultStoreRelayClient = createSimplePoolRelayClient();

export async function publishOrderReceipt(
  input: PublishOrderInput,
  relayClient: StoreRelayClient = defaultStoreRelayClient,
): Promise<PublishedOrder> {
  const context = await resolveStoreContext(input.storeUrl);
  const relays = resolveRelayList(input.relayList, getOrderRelays(context.storeTags));
  const eventTimestamp = Math.floor(Date.now() / 1000);
  const orderId =
    input.orderId ??
    generateOrderId(
      JSON.stringify({
        buyer: input.buyer,
        items: input.items,
        subtotal: input.subtotal,
        shipping: input.shipping,
        total: input.total,
        storeId: context.lookupHash,
      }),
    );

  const order: OrderMessage = {
    version: 1,
    orderId,
    timestamp: input.timestamp ?? eventTimestamp,
    storeId: context.lookupHash,
    items: input.items.map((item) => ({ i: item.i, qty: item.qty, ...(item.v ? { v: item.v } : {}) })),
    subtotal: input.subtotal,
    shipping: input.shipping,
    total: input.total,
    totalSats: input.totalSats,
    exchangeRate: input.exchangeRate,
    rateSource: input.rateSource,
    buyer: Object.fromEntries(Object.entries(input.buyer).map(([key, value]) => [key, String(value)])),
    paymentMethod: input.paymentMethod,
    paymentCurrency: input.paymentCurrency,
    paymentAmount: input.paymentAmount,
  };

  const orderSecret = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: NOWHERE_APPLICATION_KIND,
      created_at: eventTimestamp,
      content: nip44Encrypt(JSON.stringify(order), getConversationKey(orderSecret, context.sellerPubkeyHex)),
      tags: [
        ['d', `${NOWHERE_DTAG_PREFIX}/${order.orderId}`],
        ['t', NOWHERE_T_TAG],
      ],
    },
    orderSecret,
  );

  await relayClient.publish(event, relays, 'NIP-78 order');

  const receiptSecret = generateSecretKey();
  const receiptPayload: OrderReceipt = {
    v: 1,
    p: getPublicKey(receiptSecret),
    c: nip44Encrypt(JSON.stringify(event), getConversationKey(receiptSecret, context.sellerPubkeyHex)),
  };

  return {
    context,
    relays,
    order,
    event,
    receiptPayload,
    receipt: JSON.stringify(receiptPayload),
  };
}

export function decryptOrderEvent(event: Event, sellerSecret: string | Uint8Array): OrderMessage {
  const conversationKey = getConversationKey(normalizeSecret(sellerSecret), event.pubkey);
  const plaintext = nip44Decrypt(event.content, conversationKey);
  const parsed = JSON.parse(plaintext);
  if (!isOrderMessage(parsed)) {
    throw new Error('Decrypted content is not a valid Nowhere order.');
  }
  return parsed;
}

export function decryptOrderReceipt(receipt: string | OrderReceipt, sellerSecret: string | Uint8Array): DecryptedOrder {
  const parsedReceipt = typeof receipt === 'string' ? JSON.parse(receipt) : receipt;
  if (!isRecord(parsedReceipt) || parsedReceipt.v !== 1 || typeof parsedReceipt.p !== 'string' || typeof parsedReceipt.c !== 'string') {
    throw new Error('Invalid Nowhere order receipt.');
  }

  const secret = normalizeSecret(sellerSecret);
  const eventJson = nip44Decrypt(parsedReceipt.c, getConversationKey(secret, parsedReceipt.p));
  const eventValue = JSON.parse(eventJson);
  if (!isEvent(eventValue)) {
    throw new Error('Receipt did not decrypt to a Nostr event.');
  }
  if (!verifyEvent(eventValue)) {
    throw new Error('Receipt event signature verification failed.');
  }

  return {
    event: eventValue,
    order: decryptOrderEvent(eventValue, secret),
  };
}

export async function fetchOrdersForSeller(
  input: FetchOrdersInput,
  relayClient: StoreRelayClient = defaultStoreRelayClient,
): Promise<FetchedOrders> {
  const context = await resolveStoreContext(input.storeUrl);
  const relays = resolveRelayList(input.relayList, getOrderRelays(context.storeTags));
  const filter: Filter = {
    kinds: [NOWHERE_APPLICATION_KIND],
    '#t': [NOWHERE_T_TAG],
  };

  if (input.since !== undefined) {
    filter.since = input.since;
  }
  if (input.until !== undefined) {
    filter.until = input.until;
  }
  if (input.limit !== undefined) {
    filter.limit = input.limit;
  }

  const orders: DecryptedOrder[] = [];
  const failedEventIds: string[] = [];
  const seenOrderIds = new Set<string>();

  for (const event of sortEventsDescending(await relayClient.fetchEvents(filter, relays))) {
    try {
      const order = decryptOrderEvent(event, input.sellerSecret);
      if (order.storeId !== context.lookupHash || seenOrderIds.has(order.orderId)) {
        continue;
      }
      seenOrderIds.add(order.orderId);
      orders.push({ event, order });
    } catch {
      failedEventIds.push(event.id);
    }
  }

  return {
    context,
    relays,
    orders,
    failedEventIds,
  };
}

export async function publishStoreStatus(
  input: PublishStatusInput,
  relayClient: StoreRelayClient = defaultStoreRelayClient,
): Promise<PublishedStatus> {
  const context = await resolveStoreContext(input.storeUrl);
  const sellerSecret = normalizeSecret(input.sellerSecret);
  const relays = resolveRelayList(input.relayList, getInventoryRelays(context.storeTags));
  const { pubkey: inventoryPubkey } = deriveInventoryKeypair(context.storeFragment);
  const event = finalizeEvent(
    {
      kind: NOWHERE_APPLICATION_KIND,
      created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
      content: nip44Encrypt(JSON.stringify(input.payload), getConversationKey(sellerSecret, inventoryPubkey)),
      tags: [
        ['d', `${NOWHERE_DTAG_PREFIX}/${context.lookupHash}`],
        ['t', NOWHERE_T_TAG],
      ],
    },
    sellerSecret,
  );

  await relayClient.publish(event, relays, 'inventory status');

  return {
    context,
    relays,
    event,
    payload: input.payload,
  };
}

export async function fetchCurrentStatus(
  input: FetchStatusInput,
  relayClient: StoreRelayClient = defaultStoreRelayClient,
): Promise<FetchedStatus> {
  const context = await resolveStoreContext(input.storeUrl);
  const relays = resolveRelayList(input.relayList, getInventoryRelays(context.storeTags));
  const event = await relayClient.fetchEvent(
    {
      kinds: [NOWHERE_APPLICATION_KIND],
      authors: [context.sellerPubkeyHex],
      '#d': [`${NOWHERE_DTAG_PREFIX}/${context.lookupHash}`],
    },
    relays,
  );

  if (!event) {
    return {
      context,
      relays,
      event: null,
      payload: null,
    };
  }

  try {
    const { privkey } = deriveInventoryKeypair(context.storeFragment);
    const plaintext = nip44Decrypt(event.content, getConversationKey(privkey, event.pubkey));
    const parsed = JSON.parse(plaintext);
    if (!isStatusPayload(parsed)) {
      return { context, relays, event, payload: null };
    }
    return {
      context,
      relays,
      event,
      payload: parsed,
    };
  } catch {
    return {
      context,
      relays,
      event,
      payload: null,
    };
  }
}
