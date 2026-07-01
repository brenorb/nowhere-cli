import { base64urlToHex, type Item, type StoreData, type Tag } from '@nowhere/codec';
import { createHash, createHmac } from 'node:crypto';
import { Filter } from 'nostr-tools/filter';
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { type Event, finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type VerifiedEvent } from 'nostr-tools/pure';
import type { CliSigner } from './active-signer.js';
import { resolveSiteInput } from './fragments.js';
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
  sellerSecret?: string | Uint8Array;
  sellerSigner?: CliSigner;
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

export interface FetchOrdersByIdsInput {
  storeUrl: string;
  sellerSecret?: string | Uint8Array;
  sellerSigner?: CliSigner;
  orderIds: string[];
  relayList?: string[];
}

export interface HistoricalRateResult {
  satsPerUnit: number;
  source: string;
}

export interface OrderVerification {
  error: string | null;
  expectedSubtotal: number;
  expectedShipping: number;
  expectedTotal: number;
  historicalSatsPerUnit: number | null;
  rateSource: string;
  expectedSats: number | null;
  expectedPaymentAmount: number | null;
  paymentCurrencyLabel: string | null;
  paymentAmountMatch: boolean | null;
  paymentRateSource: string | null;
  subtotalMatch: boolean | null;
  shippingMatch: boolean | null;
  totalMatch: boolean | null;
}

export interface VerifyStoreOrderOptions {
  storeUrl: string;
  order: OrderMessage;
  receivedSats?: number;
  storeRateOverride?: HistoricalRateResult;
  paymentRateOverride?: HistoricalRateResult;
}

export interface VerifiedStoreOrder {
  ok: boolean;
  order: OrderMessage;
  verification: OrderVerification;
}

export type StoreVerificationSource = 'receipt' | 'event' | 'order';

export interface VerifyStoreOrderPayloadOptions {
  storeUrl: string;
  payload: unknown;
  sellerSecret?: string | Uint8Array;
  sellerSigner?: CliSigner;
  receivedSats?: number;
  storeRateOverride?: HistoricalRateResult;
  paymentRateOverride?: HistoricalRateResult;
}

export interface VerifiedStoreOrderPayload extends VerifiedStoreOrder {
  source: StoreVerificationSource;
}

export interface PublishStatusInput {
  storeUrl: string;
  sellerSecret?: string | Uint8Array;
  sellerSigner?: CliSigner;
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeAmountForComparison(stored: number, expected: number): number {
  const asMajorUnits = stored / 100;
  return Math.abs(asMajorUnits - expected) <= Math.abs(stored - expected) ? asMajorUnits : stored;
}

function sortEventsDescending(events: Event[]): Event[] {
  return [...events].sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return right.created_at - left.created_at;
    }
    return right.id.localeCompare(left.id);
  });
}

function getStoreCurrency(tags: Tag[]): string {
  return tags.find((tag) => tag.key === '$')?.value ?? 'USD';
}

interface VerificationCartItem {
  item: Item;
  qty: number;
  selectedVariant?: string;
}

function computeDiscount(cartItems: VerificationCartItem[], storeTags: Tag[]): { amount: number; label: string } {
  const buyMoreTag = storeTags.find((tag) => tag.key === 'B');
  if (!buyMoreTag?.value) {
    return { amount: 0, label: '' };
  }

  const parts = buyMoreTag.value.split(':');
  if (parts.length !== 2) {
    return { amount: 0, label: '' };
  }

  const minQty = Number.parseInt(parts[0] ?? '', 10);
  const percent = Number.parseInt(parts[1] ?? '', 10);
  if (Number.isNaN(minQty) || Number.isNaN(percent) || minQty < 1 || percent < 1 || percent > 100) {
    return { amount: 0, label: '' };
  }

  let discountTotal = 0;
  for (const cartItem of cartItems) {
    if (cartItem.qty >= minQty) {
      discountTotal += cartItem.item.price * cartItem.qty * (percent / 100);
    }
  }

  if (discountTotal === 0) {
    return { amount: 0, label: '' };
  }

  let amount = round2(discountTotal);
  const maxDiscountTag = storeTags.find((tag) => tag.key === 'X');
  if (maxDiscountTag?.value) {
    const maxDiscount = Number.parseInt(maxDiscountTag.value, 10) / 100;
    if (maxDiscount > 0 && amount > maxDiscount) {
      amount = maxDiscount;
    }
  }

  return {
    amount,
    label: `Buy ${minQty}+ get ${percent}% off`,
  };
}

function computeShipping(cartItems: VerificationCartItem[], storeTags: Tag[], buyerCountry?: string): number {
  const freeTag = storeTags.find((tag) => tag.key === 'F');
  if (freeTag) {
    if (!freeTag.value) {
      return 0;
    }

    const threshold = Number.parseInt(freeTag.value, 10);
    if (!Number.isNaN(threshold) && threshold > 0) {
      const subtotal = cartItems.reduce((sum, cartItem) => sum + cartItem.item.price * cartItem.qty, 0);
      const subtotalCents = Math.round(subtotal * 100);
      const storeCountry = storeTags.find((tag) => tag.key === 'L')?.value;
      const isDomestic = Boolean(buyerCountry && storeCountry && buyerCountry === storeCountry);
      const hasIntlTag = storeTags.some((tag) => tag.key === 'J');

      if (subtotalCents >= threshold && (isDomestic || hasIntlTag)) {
        return 0;
      }
    }
  }

  if (cartItems.every((cartItem) => cartItem.item.tags.some((tag) => tag.key === 'd'))) {
    return 0;
  }

  const storeCountry = storeTags.find((tag) => tag.key === 'L')?.value;
  const isDomestic = Boolean(buyerCountry && storeCountry && buyerCountry === storeCountry);

  let baseRate: number;
  let weightRate: number;
  if (isDomestic) {
    baseRate = Number.parseFloat(storeTags.find((tag) => tag.key === 's')?.value ?? '0') / 100;
    weightRate = Number.parseFloat(storeTags.find((tag) => tag.key === 'h')?.value ?? '0') / 100;
  } else {
    const intlBase = storeTags.find((tag) => tag.key === 'S')?.value;
    const domBase = storeTags.find((tag) => tag.key === 's')?.value;
    baseRate = Number.parseFloat(intlBase ?? domBase ?? '0') / 100;

    const intlWeight = storeTags.find((tag) => tag.key === 'H')?.value;
    const domWeight = storeTags.find((tag) => tag.key === 'h')?.value;
    weightRate = Number.parseFloat(intlWeight ?? domWeight ?? '0') / 100;
  }

  if (buyerCountry) {
    const override = storeTags.find((tag) => tag.key === 'R' && tag.value?.startsWith(buyerCountry));
    if (override?.value) {
      return Number.parseFloat(override.value.slice(buyerCountry.length)) / 100;
    }
  }

  let totalWeight = 0;
  for (const cartItem of cartItems) {
    if (cartItem.item.tags.some((tag) => tag.key === 'd')) {
      continue;
    }

    const itemOverride = cartItem.item.tags.find((tag) => tag.key === 'i');
    if (itemOverride?.value) {
      return Number.parseFloat(itemOverride.value) / 100;
    }

    const weightTag = cartItem.item.tags.find((tag) => tag.key === 'W');
    const weight = weightTag?.value ? Number.parseFloat(weightTag.value) : 0;
    totalWeight += weight * cartItem.qty;
  }

  return baseRate + totalWeight * weightRate;
}

const historicalRateCache = new Map<string, HistoricalRateResult>();

function historicalRateCacheKey(currency: string, timestamp: number): string {
  return `${currency.toUpperCase()}:${timestamp}`;
}

async function fetchKrakenHistorical(currency: string, timestamp: number): Promise<number | null> {
  try {
    const pair = `XBT${currency.toUpperCase()}`;
    const since = timestamp - 60;
    const response = await fetch(
      `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1&since=${since}`,
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as { error?: string[]; result?: Record<string, unknown> };
    if (data.error?.length) {
      return null;
    }

    const pairData = Object.values(data.result ?? {}).find(Array.isArray) as unknown[][] | undefined;
    if (!pairData?.length) {
      return null;
    }

    let bestCandle = pairData[0];
    for (const candle of pairData) {
      if (Number(candle[0]) <= timestamp) {
        bestCandle = candle;
      } else {
        break;
      }
    }

    const closePrice = Number.parseFloat(String(bestCandle?.[4]));
    if (!closePrice) {
      return null;
    }
    return round2(100_000_000 / closePrice);
  } catch {
    return null;
  }
}

async function fetchCoingeckoHistorical(currency: string, timestamp: number): Promise<number | null> {
  try {
    const date = new Date(timestamp * 1000);
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = date.getUTCFullYear();
    const response = await fetch(
      `https://api.coingecko.com/api/v3/coins/bitcoin/history?date=${dd}-${mm}-${yyyy}&localization=false`,
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as {
      market_data?: { current_price?: Record<string, number> };
    };
    const pricePerBtc = data.market_data?.current_price?.[currency.toLowerCase()];
    if (!pricePerBtc) {
      return null;
    }
    return round2(100_000_000 / pricePerBtc);
  } catch {
    return null;
  }
}

async function getHistoricalRate(currency: string, timestamp: number): Promise<HistoricalRateResult> {
  if (currency.toUpperCase() === 'SAT' || currency.toUpperCase() === 'SATS') {
    return { satsPerUnit: 1, source: 'native' };
  }
  if (currency.toUpperCase() === 'BTC') {
    return { satsPerUnit: 100_000_000, source: 'native' };
  }

  const cacheKey = historicalRateCacheKey(currency, timestamp);
  const cached = historicalRateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const [krakenResult, coingeckoResult] = await Promise.allSettled([
    fetchKrakenHistorical(currency, timestamp),
    fetchCoingeckoHistorical(currency, timestamp),
  ]);

  const rates: number[] = [];
  const sources: string[] = [];

  if (krakenResult.status === 'fulfilled' && krakenResult.value !== null) {
    rates.push(krakenResult.value);
    sources.push('kraken');
  }
  if (coingeckoResult.status === 'fulfilled' && coingeckoResult.value !== null) {
    rates.push(coingeckoResult.value);
    sources.push('coingecko');
  }

  if (rates.length === 0) {
    throw new Error('Failed to fetch historical exchange rate from any source');
  }

  const result = {
    satsPerUnit: round2(rates.reduce((sum, rate) => sum + rate, 0) / rates.length),
    source: sources.join('+'),
  };
  historicalRateCache.set(cacheKey, result);
  return result;
}

function fiatToSats(amount: number, satsPerUnit: number): number {
  return Math.round(amount * satsPerUnit);
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
  const resolved = await resolveSiteInput(storeUrl);
  if (!resolved.siteData || resolved.siteData.siteType !== 'store') {
    throw new Error('Expected a Nowhere store URL or fragment.');
  }
  if (!resolved.siteData.pubkey) {
    throw new Error('Store is missing a seller pubkey.');
  }
  const fragment = resolved.unsignedFragment ?? resolved.decodedFragment;
  if (!fragment) {
    throw new Error('Could not resolve the store fragment.');
  }

  return {
    storeUrl,
    storeFragment: fragment,
    lookupHash: computeLookupHash(fragment),
    sellerPubkeyHex: base64urlToHex(resolved.siteData.pubkey),
    storeTags: resolved.siteData.tags,
  };
}

async function resolveStoreData(storeUrl: string): Promise<StoreData> {
  const resolved = await resolveSiteInput(storeUrl);
  if (!resolved.siteData || resolved.siteData.siteType !== 'store') {
    throw new Error('Expected a Nowhere store URL or fragment.');
  }
  return resolved.siteData as StoreData;
}

export function createSimplePoolRelayClient(pool = new SimplePool()): StoreRelayClient {
  return {
    async publish(event: Event, relays: string[]): Promise<void> {
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

async function decryptOrderEventWithAccess(
  event: Event,
  sellerSecret?: string | Uint8Array,
  sellerSigner?: CliSigner,
): Promise<OrderMessage> {
  const plaintext = sellerSigner
    ? await sellerSigner.nip44Decrypt(event.pubkey, event.content)
    : nip44Decrypt(event.content, getConversationKey(normalizeSecret(sellerSecret as string | Uint8Array), event.pubkey));
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

export async function decryptOrderReceiptWithAccess(
  receipt: string | OrderReceipt,
  sellerSecret?: string | Uint8Array,
  sellerSigner?: CliSigner,
): Promise<DecryptedOrder> {
  const parsedReceipt = typeof receipt === 'string' ? JSON.parse(receipt) : receipt;
  if (!isRecord(parsedReceipt) || parsedReceipt.v !== 1 || typeof parsedReceipt.p !== 'string' || typeof parsedReceipt.c !== 'string') {
    throw new Error('Invalid Nowhere order receipt.');
  }
  if (!sellerSecret && !sellerSigner) {
    throw new Error('Seller secret or active signer is required to decrypt a receipt.');
  }

  const eventJson = sellerSigner
    ? await sellerSigner.nip44Decrypt(parsedReceipt.p, parsedReceipt.c)
    : nip44Decrypt(parsedReceipt.c, getConversationKey(normalizeSecret(sellerSecret as string | Uint8Array), parsedReceipt.p));
  const eventValue = JSON.parse(eventJson);
  if (!isEvent(eventValue)) {
    throw new Error('Receipt did not decrypt to a Nostr event.');
  }
  if (!verifyEvent(eventValue)) {
    throw new Error('Receipt event signature verification failed.');
  }

  return {
    event: eventValue,
    order: await decryptOrderEventWithAccess(eventValue, sellerSecret, sellerSigner),
  };
}

export async function fetchOrdersForSeller(
  input: FetchOrdersInput,
  relayClient: StoreRelayClient = defaultStoreRelayClient,
): Promise<FetchedOrders> {
  if (!input.sellerSecret && !input.sellerSigner) {
    throw new Error('Seller secret or active signer is required to fetch seller orders.');
  }
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
      const order = await decryptOrderEventWithAccess(event, input.sellerSecret, input.sellerSigner);
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

export async function fetchOrdersByIds(
  input: FetchOrdersByIdsInput,
  relayClient: StoreRelayClient = defaultStoreRelayClient,
): Promise<FetchedOrders> {
  if (!input.sellerSecret && !input.sellerSigner) {
    throw new Error('Seller secret or active signer is required to fetch seller orders.');
  }
  const context = await resolveStoreContext(input.storeUrl);
  const relays = resolveRelayList(input.relayList, getOrderRelays(context.storeTags));
  const normalizedIds = [...new Set(input.orderIds.map((orderId) => orderId.trim().toLowerCase()).filter(Boolean))];
  if (normalizedIds.length === 0) {
    return {
      context,
      relays,
      orders: [],
      failedEventIds: [],
    };
  }

  const orders: DecryptedOrder[] = [];
  const failedEventIds: string[] = [];
  const seenOrderIds = new Set<string>();
  const batchSize = 50;

  for (let index = 0; index < normalizedIds.length; index += batchSize) {
    const batch = normalizedIds.slice(index, index + batchSize);
    const events = sortEventsDescending(await relayClient.fetchEvents(
      {
        kinds: [NOWHERE_APPLICATION_KIND],
        '#d': batch.map((orderId) => `${NOWHERE_DTAG_PREFIX}/${orderId}`),
      },
      relays,
    ));

    for (const event of events) {
      try {
        const order = await decryptOrderEventWithAccess(event, input.sellerSecret, input.sellerSigner);
        const normalizedOrderId = order.orderId.toLowerCase();
        if (
          order.storeId !== context.lookupHash
          || !batch.includes(normalizedOrderId)
          || seenOrderIds.has(normalizedOrderId)
        ) {
          continue;
        }

        seenOrderIds.add(normalizedOrderId);
        orders.push({ event, order });
      } catch {
        failedEventIds.push(event.id);
      }
    }
  }

  return {
    context,
    relays,
    orders,
    failedEventIds,
  };
}

async function parseOrderPayload(
  payload: unknown,
  sellerSecret?: string | Uint8Array,
  sellerSigner?: CliSigner,
): Promise<{ order: OrderMessage; source: StoreVerificationSource }> {
  if (isRecord(payload) && payload.v === 1 && typeof payload.p === 'string' && typeof payload.c === 'string') {
    if (!sellerSecret && !sellerSigner) {
      throw new Error('Seller secret or active signer is required to verify a receipt payload.');
    }

    return {
      order: (await decryptOrderReceiptWithAccess({
        v: 1,
        p: payload.p,
        c: payload.c,
      }, sellerSecret, sellerSigner)).order,
      source: 'receipt',
    };
  }

  if (isEvent(payload)) {
    if (!sellerSecret && !sellerSigner) {
      throw new Error('Seller secret or active signer is required to verify an encrypted order event.');
    }

    return {
      order: await decryptOrderEventWithAccess(payload, sellerSecret, sellerSigner),
      source: 'event',
    };
  }

  if (isOrderMessage(payload)) {
    return {
      order: payload,
      source: 'order',
    };
  }

  throw new Error('Expected a receipt, encrypted order event, or plaintext order JSON.');
}

export async function verifyStoreOrder(
  input: VerifyStoreOrderOptions,
): Promise<VerifiedStoreOrder> {
  const storeData = await resolveStoreData(input.storeUrl);
  const storeCurrency = getStoreCurrency(storeData.tags);
  const cartItems: VerificationCartItem[] = input.order.items
    .filter((orderItem) => storeData.items[orderItem.i])
    .map((orderItem) => ({
      item: storeData.items[orderItem.i] as Item,
      qty: orderItem.qty,
      selectedVariant: orderItem.v,
    }));

  const rawSubtotal = cartItems.reduce((sum, cartItem) => sum + cartItem.item.price * cartItem.qty, 0);
  const discount = computeDiscount(cartItems, storeData.tags).amount;
  const expectedSubtotal = round2(rawSubtotal - discount);
  const expectedShipping = computeShipping(cartItems, storeData.tags, input.order.buyer?.country);
  const expectedTotal = round2(expectedSubtotal + expectedShipping);

  const subtotalMatch = Math.abs(normalizeAmountForComparison(input.order.subtotal, expectedSubtotal) - expectedSubtotal) < 0.02;
  const shippingMatch = Math.abs(normalizeAmountForComparison(input.order.shipping, expectedShipping) - expectedShipping) < 0.02;
  const totalMatch = Math.abs(normalizeAmountForComparison(input.order.total, expectedTotal) - expectedTotal) < 0.02;
  let ok = subtotalMatch && shippingMatch && totalMatch;

  let historicalSatsPerUnit: number | null = null;
  let rateSource = '';
  let expectedSats: number | null = null;
  let expectedPaymentAmount: number | null = null;
  let paymentCurrencyLabel: string | null = null;
  let paymentAmountMatch: boolean | null = null;
  let paymentRateSource: string | null = null;

  const payCurrency = input.order.paymentCurrency?.toUpperCase();
  const isSatsPayment = !payCurrency || payCurrency === 'BTC' || payCurrency === 'SATS' || payCurrency === 'SAT';

  if (isSatsPayment) {
    try {
      const rate = input.storeRateOverride ?? await getHistoricalRate(storeCurrency, input.order.timestamp);
      historicalSatsPerUnit = rate.satsPerUnit;
      rateSource = rate.source;
      expectedSats = fiatToSats(expectedTotal, rate.satsPerUnit);

      if (input.receivedSats !== undefined && expectedSats > 0) {
        const diff = Math.abs(input.receivedSats - expectedSats) / expectedSats;
        if (diff > 0.02) {
          ok = false;
        }
      }
    } catch {
      rateSource = 'unavailable';
    }
  } else {
    paymentCurrencyLabel = input.order.paymentCurrency ?? null;
    try {
      const [storeRate, paymentRate] = await Promise.all([
        input.storeRateOverride ?? getHistoricalRate(storeCurrency, input.order.timestamp),
        input.paymentRateOverride ?? getHistoricalRate(input.order.paymentCurrency ?? '', input.order.timestamp),
      ]);
      expectedPaymentAmount = round2(expectedTotal * storeRate.satsPerUnit / paymentRate.satsPerUnit);
      paymentAmountMatch = input.order.paymentAmount !== undefined && expectedPaymentAmount > 0
        ? Math.abs(normalizeAmountForComparison(input.order.paymentAmount, expectedPaymentAmount) - expectedPaymentAmount) / expectedPaymentAmount <= 0.01
        : null;
      if (paymentAmountMatch === false) {
        ok = false;
      }
      paymentRateSource = [storeRate.source, paymentRate.source]
        .filter((source, idx, sources) => source !== 'native' && sources.indexOf(source) === idx)
        .join('+') || 'native';
    } catch {
      paymentRateSource = 'unavailable';
    }
  }

  return {
    ok,
    order: input.order,
    verification: {
      error: null,
      expectedSubtotal,
      expectedShipping,
      expectedTotal,
      historicalSatsPerUnit,
      rateSource,
      expectedSats,
      expectedPaymentAmount,
      paymentCurrencyLabel,
      paymentAmountMatch,
      paymentRateSource,
      subtotalMatch,
      shippingMatch,
      totalMatch,
    },
  };
}

export async function verifyStoreOrderPayload(
  input: VerifyStoreOrderPayloadOptions,
): Promise<VerifiedStoreOrderPayload> {
  const { order, source } = await parseOrderPayload(input.payload, input.sellerSecret, input.sellerSigner);
  return {
    source,
    ...(await verifyStoreOrder({
      storeUrl: input.storeUrl,
      order,
      receivedSats: input.receivedSats,
      storeRateOverride: input.storeRateOverride,
      paymentRateOverride: input.paymentRateOverride,
    })),
  };
}

export async function publishStoreStatus(
  input: PublishStatusInput,
  relayClient: StoreRelayClient = defaultStoreRelayClient,
): Promise<PublishedStatus> {
  if (!input.sellerSecret && !input.sellerSigner) {
    throw new Error('Seller secret or active signer is required to publish store status.');
  }
  const context = await resolveStoreContext(input.storeUrl);
  const relays = resolveRelayList(input.relayList, getInventoryRelays(context.storeTags));
  const { pubkey: inventoryPubkey } = deriveInventoryKeypair(context.storeFragment);
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const content = input.sellerSigner
    ? await input.sellerSigner.nip44Encrypt(inventoryPubkey, JSON.stringify(input.payload))
    : nip44Encrypt(
      JSON.stringify(input.payload),
      getConversationKey(normalizeSecret(input.sellerSecret as string | Uint8Array), inventoryPubkey),
    );
  const unsigned = {
    kind: NOWHERE_APPLICATION_KIND,
    created_at: createdAt,
    content,
    tags: [
      ['d', `${NOWHERE_DTAG_PREFIX}/${context.lookupHash}`],
      ['t', NOWHERE_T_TAG],
    ],
  };
  let signedEvent: VerifiedEvent;
  if (input.sellerSigner) {
    const candidate = await input.sellerSigner.signEvent(unsigned);
    if (!verifyEvent(candidate)) {
      throw new Error('Store status signer returned an invalid signature.');
    }
    signedEvent = candidate;
  } else {
    signedEvent = finalizeEvent(unsigned, normalizeSecret(input.sellerSecret as string | Uint8Array));
  }

  await relayClient.publish(signedEvent, relays, 'inventory status');

  return {
    context,
    relays,
    event: signedEvent,
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
