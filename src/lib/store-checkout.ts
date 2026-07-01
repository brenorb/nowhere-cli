import { formatCurrency, resolveTags, type Item, type StoreData, type Tag } from '@nowhere/codec';
import { fetchInvoice, resolveLightningAddress } from './lightning.js';
import {
  createSimplePoolRelayClient,
  fetchCurrentStatus,
  generateOrderId,
  publishOrderReceipt,
  resolveStoreContext,
  type OrderItem,
  type PublishedOrder,
  type StatusPayload,
  type StoreRelayClient,
} from './store-live.js';
import { resolveSiteInput } from './fragments.js';
import { getAvailablePaymentMethods, getPaymentMethod, type AvailablePaymentMethod, type PaymentMethodConfig } from './payment-methods.js';

export interface CheckoutCartItem extends OrderItem {}

export interface CheckoutFieldSpec {
  visible: string[];
  required: string[];
  custom: Array<{ key: string; label: string; from: string }>;
}

export interface InventoryGateResult {
  enabled: boolean;
  gate: 'ok' | 'missing_status' | 'closed';
  payload: StatusPayload | null;
}

export interface QuotedPaymentMethod extends AvailablePaymentMethod {
  disabled?: boolean;
  disabledReason?: string;
  belowMinimumWarning?: string;
}

export interface QuotedCheckoutItem {
  index: number;
  name: string;
  qty: number;
  variant?: string;
  stockLevel: number | null;
  unavailable: boolean;
  lowStock: boolean;
}

export interface StoreCheckoutQuote {
  storeCurrency: string;
  shippingCurrency: string | null;
  subtotal: number;
  discount: { amount: number; label: string };
  shipping: number;
  total: number;
  inventory: InventoryGateResult;
  fields: CheckoutFieldSpec;
  countries: {
    allowed: string[] | null;
    excluded: string[] | null;
  };
  items: QuotedCheckoutItem[];
  methods: QuotedPaymentMethod[];
}

export type StoreCheckoutFlow = 'lightning' | 'manual';

export interface StoreCheckoutResult {
  flow: StoreCheckoutFlow;
  quote: StoreCheckoutQuote;
  published: PublishedOrder;
  method: {
    id: string;
    name: string;
    type: 'crypto' | 'fiat';
    color: string;
  };
  invoice?: string;
  lightningAddress?: string;
  amountSats?: number;
  amountFiat?: number;
  paymentCurrency?: string;
  paymentAmount?: number;
  formattedAmount?: string;
  instructions?: string;
  exchangeRate?: string;
  qrValue?: string;
}

function isRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function centsToUnits(value: number): number {
  return round2(value / 100);
}

function getStoreCurrency(tags: Tag[]): string {
  return tags.find((tag) => tag.key === '$')?.value ?? 'USD';
}

function getShippingCurrency(tags: Tag[]): string | null {
  return tags.find((tag) => tag.key === 'K')?.value ?? null;
}

function computeDiscount(cartItems: Array<{ item: Item; qty: number }>, storeTags: Tag[]): { amount: number; label: string } {
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

  let total = 0;
  for (const cartItem of cartItems) {
    if (cartItem.qty >= minQty) {
      total += cartItem.item.price * cartItem.qty * (percent / 100);
    }
  }
  if (total === 0) {
    return { amount: 0, label: '' };
  }

  let amount = round2(total);
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

function computeShipping(
  cartItems: Array<{ item: Item; qty: number }>,
  storeTags: Tag[],
  buyerCountry?: string,
): number {
  const freeTag = storeTags.find((tag) => tag.key === 'F');
  if (freeTag) {
    if (!freeTag.value) {
      return 0;
    }

    const threshold = Number.parseInt(freeTag.value, 10);
    if (!Number.isNaN(threshold) && threshold > 0) {
      const subtotalCents = Math.round(cartItems.reduce((sum, cartItem) => sum + cartItem.item.price * cartItem.qty, 0) * 100);
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

async function fetchCoingecko(currency: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${currency.toLowerCase()}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as { bitcoin?: Record<string, number> };
    const pricePerBtc = data.bitcoin?.[currency.toLowerCase()];
    return pricePerBtc ? round2(100_000_000 / pricePerBtc) : null;
  } catch {
    return null;
  }
}

async function fetchYadio(currency: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.yadio.io/exrates/${currency.toUpperCase()}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as Record<string, { price?: number }>;
    const pricePerBtc = data[currency.toUpperCase()]?.price;
    return pricePerBtc ? round2(100_000_000 / pricePerBtc) : null;
  } catch {
    return null;
  }
}

async function fetchKraken(currency: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.kraken.com/0/public/Ticker?pair=XBT${currency.toUpperCase()}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as { result?: Record<string, { c?: [string] }> };
    const result = Object.values(data.result ?? {})[0];
    const price = result?.c?.[0];
    return price ? round2(100_000_000 / Number.parseFloat(price)) : null;
  } catch {
    return null;
  }
}

async function getExchangeRate(currency: string): Promise<{ satsPerUnit: number; source: string }> {
  const normalized = currency.toUpperCase();
  if (normalized === 'SAT' || normalized === 'SATS') {
    return { satsPerUnit: 1, source: 'native' };
  }
  if (normalized === 'BTC') {
    return { satsPerUnit: 100_000_000, source: 'native' };
  }

  const results = await Promise.allSettled([
    fetchCoingecko(currency),
    fetchYadio(currency),
    fetchKraken(currency),
  ]);

  const rates: number[] = [];
  const sources: string[] = [];
  if (results[0].status === 'fulfilled' && results[0].value) {
    rates.push(results[0].value);
    sources.push('coingecko');
  }
  if (results[1].status === 'fulfilled' && results[1].value) {
    rates.push(results[1].value);
    sources.push('yadio');
  }
  if (results[2].status === 'fulfilled' && results[2].value) {
    rates.push(results[2].value);
    sources.push('kraken');
  }

  if (rates.length === 0) {
    throw new Error('Failed to fetch exchange rate from any source');
  }

  return {
    satsPerUnit: round2(rates.reduce((sum, rate) => sum + rate, 0) / rates.length),
    source: sources.join('+'),
  };
}

async function convertFiat(amount: number, fromCurrency: string, toCurrency: string) {
  if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) {
    const rate = await getExchangeRate(fromCurrency);
    return { convertedAmount: amount, fromRate: rate, toRate: rate };
  }

  const [fromRate, toRate] = await Promise.all([
    getExchangeRate(fromCurrency),
    getExchangeRate(toCurrency),
  ]);

  return {
    convertedAmount: round2((amount * fromRate.satsPerUnit) / toRate.satsPerUnit),
    fromRate,
    toRate,
  };
}

function fiatToSats(amount: number, satsPerUnit: number): number {
  return Math.round(amount * satsPerUnit);
}

async function resolveStoreData(storeInput: string): Promise<StoreData> {
  const resolved = await resolveSiteInput(storeInput);
  if (!resolved.siteData || resolved.siteData.siteType !== 'store') {
    throw new Error('Expected a Nowhere store URL or fragment.');
  }
  return resolved.siteData as StoreData;
}

function resolveCartItems(storeData: StoreData, items: CheckoutCartItem[]): Array<{
  item: Item;
  itemIndex: number;
  qty: number;
  selectedVariant?: string;
}> {
  return items.map((entry, index) => {
    const item = storeData.items[entry.i];
    if (!item) {
      throw new Error(`Cart item ${index} references missing store item ${entry.i}.`);
    }
    if (!Number.isInteger(entry.qty) || entry.qty < 1) {
      throw new Error(`Cart item ${index} has an invalid quantity.`);
    }

    const variantTag = item.tags.find((tag) => tag.key === 'v')?.value;
    const variants = variantTag ? variantTag.split('.').map((variant) => variant.trim()).filter(Boolean) : [];
    if (entry.v && variants.length > 0 && !variants.includes(entry.v)) {
      throw new Error(`Cart item ${index} selected unknown variant "${entry.v}".`);
    }

    return {
      item,
      itemIndex: entry.i,
      qty: entry.qty,
      selectedVariant: entry.v,
    };
  });
}

async function fetchInventoryGate(
  storeInput: string,
  storeData: StoreData,
  relayClient: StoreRelayClient,
  relayList?: string[],
): Promise<InventoryGateResult> {
  const inventoryEnabled = storeData.tags.some((tag) => tag.key === 'k');
  if (!inventoryEnabled) {
    return { enabled: false, gate: 'ok', payload: null };
  }

  const status = await fetchCurrentStatus({ storeUrl: storeInput, relayList }, relayClient);
  if (!status.payload) {
    return { enabled: true, gate: 'missing_status', payload: null };
  }
  if (status.payload.closed) {
    return { enabled: true, gate: 'closed', payload: status.payload };
  }
  return { enabled: true, gate: 'ok', payload: status.payload };
}

function deriveFieldSpec(
  storeData: StoreData,
  cartItems: Array<{ item: Item; itemIndex: number; qty: number; selectedVariant?: string }>,
  quoteItems: QuotedCheckoutItem[],
  inventoryPayload: StatusPayload | null,
): CheckoutFieldSpec {
  const resolvedTags = cartItems.reduce<Tag[]>((tags, cartItem) => resolveTags(tags, cartItem.item.tags), [...storeData.tags]);
  const hasLowStock = quoteItems.some((item) => item.lowStock);
  const lowFields = inventoryPayload?.low?.fields?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  const lowStockActive = hasLowStock && inventoryPayload?.low;

  const visible = new Set<string>();
  const required = new Set<string>();
  const custom: Array<{ key: string; label: string; from: string }> = [];

  const useField = (field: string, mode: 'required' | 'optional' = 'required') => {
    visible.add(field);
    if (mode === 'required') {
      required.add(field);
    }
  };

  if (resolvedTags.some((tag) => tag.key === 'N' || tag.key === 'n') || (lowStockActive && lowFields.includes('name'))) {
    useField('name', resolvedTags.some((tag) => tag.key === 'N') || (lowStockActive && lowFields.includes('name')) ? 'required' : 'optional');
  }
  if (resolvedTags.some((tag) => tag.key === 'E' || tag.key === 'e') || (lowStockActive && lowFields.includes('email'))) {
    useField('email', resolvedTags.some((tag) => tag.key === 'E') || (lowStockActive && lowFields.includes('email')) ? 'required' : 'optional');
  }
  if (resolvedTags.some((tag) => tag.key === 'P' || tag.key === 'p') || (lowStockActive && lowFields.includes('phone'))) {
    useField('phone', resolvedTags.some((tag) => tag.key === 'P') || (lowStockActive && lowFields.includes('phone')) ? 'required' : 'optional');
  }
  if (resolvedTags.some((tag) => tag.key === 'Z' || tag.key === 'z') || (lowStockActive && lowFields.includes('nostr'))) {
    useField('nostr', resolvedTags.some((tag) => tag.key === 'Z') || (lowStockActive && lowFields.includes('nostr')) ? 'required' : 'optional');
  }

  const addressVisible = resolvedTags.some((tag) => tag.key === 'A' || tag.key === 'a') || (lowStockActive && lowFields.includes('address'));
  const addressRequired = resolvedTags.some((tag) => tag.key === 'A') || (lowStockActive && lowFields.includes('address'));
  if (addressVisible) {
    useField('street', addressRequired ? 'required' : 'optional');
    useField('city', addressRequired ? 'required' : 'optional');
    useField('state', 'optional');
    useField('postal', 'optional');
    useField('country', addressRequired ? 'required' : 'optional');
  }

  if (lowStockActive && lowFields.includes('notes')) {
    useField('notes', 'required');
  } else {
    useField('notes', 'optional');
  }

  if (lowStockActive && inventoryPayload?.low?.refund) {
    useField('refundAddress', 'required');
  }

  let customIndex = 0;
  for (const cartItem of cartItems) {
    const tag = cartItem.item.tags.find((entry) => entry.key === 't');
    if (!tag) {
      continue;
    }
    const key = `custom_${customIndex}`;
    customIndex += 1;
    visible.add(key);
    custom.push({
      key,
      label: tag.value || 'Custom text',
      from: cartItem.item.name,
    });
  }

  return {
    visible: [...visible],
    required: [...required],
    custom,
  };
}

async function quotePaymentMethods(methods: AvailablePaymentMethod[], total: number, storeCurrency: string): Promise<QuotedPaymentMethod[]> {
  const results: QuotedPaymentMethod[] = [];

  for (const method of methods) {
    const result: QuotedPaymentMethod = { ...method };
    if (total > 0) {
      try {
        if (method.method.maxTransaction > 0) {
          const { convertedAmount } = await convertFiat(total, storeCurrency, method.method.maxTransactionCurrency);
          if (convertedAmount > method.method.maxTransaction) {
            result.disabled = true;
            result.disabledReason = `Exceeds ${method.method.maxTransaction} ${method.method.maxTransactionCurrency} limit`;
          }
        }

        if (method.method.minTransaction > 0 && !result.disabled) {
          const { convertedAmount } = await convertFiat(total, storeCurrency, method.method.minTransactionCurrency);
          if (convertedAmount < method.method.minTransaction) {
            result.belowMinimumWarning = `Minimum ${method.method.minTransaction} ${method.method.minTransactionCurrency} - you will be charged the minimum`;
          }
        }
      } catch {
        // Leave method available if live conversion failed.
      }
    }
    results.push(result);
  }

  return results;
}

function validateBuyerData(quote: StoreCheckoutQuote, buyer: Record<string, string>): void {
  for (const field of quote.fields.required) {
    if (!buyer[field]?.trim()) {
      throw new Error(`Buyer field "${field}" is required.`);
    }
  }

  const country = buyer.country?.trim();
  if (quote.countries.allowed && country && !quote.countries.allowed.includes(country)) {
    throw new Error(`Buyer country must be one of: ${quote.countries.allowed.join(', ')}.`);
  }
  if (quote.countries.excluded && country && quote.countries.excluded.includes(country)) {
    throw new Error(`Buyer country ${country} is excluded for this checkout.`);
  }
}

function requireMethod(quote: StoreCheckoutQuote, methodId: string, storeTags: Tag[]): PaymentMethodConfig {
  const method = getPaymentMethod(methodId, storeTags);
  if (!method) {
    throw new Error(`Unsupported payment method "${methodId}".`);
  }

  const quoted = quote.methods.find((entry) => entry.method.id === methodId);
  if (!quoted) {
    throw new Error(`Payment method "${methodId}" is not available for this store.`);
  }
  if (quoted.disabled) {
    throw new Error(quoted.disabledReason || `Payment method "${methodId}" is currently unavailable.`);
  }

  return method;
}

export async function quoteStoreCheckout(
  input: {
    storeUrl: string;
    items: CheckoutCartItem[];
    buyerCountry?: string;
    relayList?: string[];
  },
  relayClient: StoreRelayClient = createSimplePoolRelayClient(),
): Promise<StoreCheckoutQuote> {
  const storeData = await resolveStoreData(input.storeUrl);
  const cartItems = resolveCartItems(storeData, input.items);
  const inventory = await fetchInventoryGate(input.storeUrl, storeData, relayClient, input.relayList);

  const quoteItems = cartItems.map((cartItem) => {
    const stockLevel = inventory.payload
      ? (cartItem.selectedVariant ? inventory.payload.variants?.[String(cartItem.itemIndex)]?.[cartItem.selectedVariant] : undefined)
        ?? inventory.payload.items?.[String(cartItem.itemIndex)]
        ?? 3
      : null;
    const discontinued = cartItem.item.tags.some((tag) => tag.key === 'o');
    return {
      index: cartItem.itemIndex,
      name: cartItem.item.name,
      qty: cartItem.qty,
      ...(cartItem.selectedVariant ? { variant: cartItem.selectedVariant } : {}),
      stockLevel,
      unavailable: discontinued || stockLevel === 0 || stockLevel === 1,
      lowStock: stockLevel === 2,
    };
  });

  const subtotal = round2(cartItems.reduce((sum, cartItem) => sum + cartItem.item.price * cartItem.qty, 0));
  const discount = computeDiscount(cartItems, storeData.tags);
  const shipping = computeShipping(cartItems, storeData.tags, input.buyerCountry);
  const total = round2(subtotal - discount.amount + shipping);
  const fields = deriveFieldSpec(storeData, cartItems, quoteItems, inventory.payload);

  const allowedCountries = (() => {
    const tag = storeData.tags.find((entry) => entry.key === 'c');
    return tag?.value ? tag.value.split('.').filter(Boolean) : null;
  })();
  const excludedCountries = (() => {
    const tag = storeData.tags.find((entry) => entry.key === 'x');
    return tag?.value ? tag.value.split('.').filter(Boolean) : null;
  })();

  return {
    storeCurrency: getStoreCurrency(storeData.tags),
    shippingCurrency: getShippingCurrency(storeData.tags),
    subtotal,
    discount,
    shipping,
    total,
    inventory,
    fields,
    countries: {
      allowed: allowedCountries,
      excluded: excludedCountries,
    },
    items: quoteItems,
    methods: await quotePaymentMethods(getAvailablePaymentMethods(storeData.tags), total, getStoreCurrency(storeData.tags)),
  };
}

export async function beginStoreCheckout(
  input: {
    storeUrl: string;
    items: CheckoutCartItem[];
    buyer: Record<string, string>;
    methodId?: string;
    relayList?: string[];
  },
  relayClient: StoreRelayClient = createSimplePoolRelayClient(),
): Promise<StoreCheckoutResult> {
  if (!isRecord(input.buyer)) {
    throw new Error('Buyer payload must be an object.');
  }

  const storeData = await resolveStoreData(input.storeUrl);
  const context = await resolveStoreContext(input.storeUrl);
  const quote = await quoteStoreCheckout({
    storeUrl: input.storeUrl,
    items: input.items,
    buyerCountry: input.buyer.country,
    relayList: input.relayList,
  }, relayClient);

  if (quote.inventory.gate === 'missing_status') {
    throw new Error('Inventory could not be loaded for this store.');
  }
  if (quote.inventory.gate === 'closed') {
    throw new Error(quote.inventory.payload?.closed || 'Store checkout is closed.');
  }
  if (quote.items.some((item) => item.unavailable)) {
    throw new Error('Cart contains sold-out or unavailable items.');
  }

  validateBuyerData(quote, input.buyer);

  const methodId = input.methodId ?? 'bitcoin';
  const method = requireMethod(quote, methodId, storeData.tags);
  const selected = quote.methods.find((entry) => entry.method.id === methodId);
  if (!selected) {
    throw new Error(`Payment method "${methodId}" is not available.`);
  }

  const orderId = generateOrderId(JSON.stringify(input.items) + JSON.stringify(input.buyer));
  const subtotalCents = Math.round(quote.subtotal * 100);
  const shippingCents = Math.round(quote.shipping * 100);
  const totalCents = Math.round(quote.total * 100);

  if (method.type === 'crypto') {
    const rate = await getExchangeRate(quote.storeCurrency);
    const totalSats = fiatToSats(quote.total, rate.satsPerUnit);
    const published = await publishOrderReceipt({
      storeUrl: input.storeUrl,
      relayList: input.relayList,
      orderId,
      items: input.items,
      subtotal: subtotalCents,
      shipping: shippingCents,
      total: totalCents,
      totalSats,
      exchangeRate: rate.satsPerUnit,
      rateSource: rate.source,
      buyer: input.buyer,
      paymentMethod: method.id,
    }, relayClient);

    const lightningAddress = storeData.tags.find((tag) => tag.key === 'l')?.value;
    if (!lightningAddress) {
      throw new Error('Seller has no lightning address configured. Please contact the seller directly.');
    }

    const params = await resolveLightningAddress(lightningAddress);
    const amountMsats = totalSats * 1000;
    if (amountMsats < params.minSendable || amountMsats > params.maxSendable) {
      throw new Error(`Amount ${totalSats} sats is outside the seller's accepted range.`);
    }

    return {
      flow: 'lightning',
      quote,
      published,
      method: {
        id: method.id,
        name: method.name,
        type: method.type,
        color: method.color,
      },
      invoice: await fetchInvoice(params.callback, amountMsats, `Order ${published.order.orderId}`),
      lightningAddress,
      amountSats: totalSats,
      amountFiat: quote.total,
    };
  }

  let paymentAmount = quote.total;
  let paymentCurrency = quote.storeCurrency;
  let exchangeRate = '';

  if (method.currencies.length > 0 && !method.currencies.includes(paymentCurrency.toUpperCase())) {
    paymentCurrency = method.currencies[0] ?? paymentCurrency;
    const converted = await convertFiat(quote.total, quote.storeCurrency, paymentCurrency);
    paymentAmount = converted.convertedAmount;
    exchangeRate = `1 ${quote.storeCurrency.toUpperCase()} = ${round2(converted.fromRate.satsPerUnit / converted.toRate.satsPerUnit)} ${paymentCurrency.toUpperCase()}`;
  }

  if (method.minTransaction > 0) {
    let checkAmount = paymentAmount;
    if (paymentCurrency.toUpperCase() !== method.minTransactionCurrency.toUpperCase()) {
      checkAmount = (await convertFiat(paymentAmount, paymentCurrency, method.minTransactionCurrency)).convertedAmount;
    }
    if (checkAmount < method.minTransaction) {
      paymentAmount = paymentCurrency.toUpperCase() === method.minTransactionCurrency.toUpperCase()
        ? method.minTransaction
        : (await convertFiat(method.minTransaction, method.minTransactionCurrency, paymentCurrency)).convertedAmount;
    }
  }

  if (method.maxTransaction > 0) {
    let checkAmount = paymentAmount;
    if (paymentCurrency.toUpperCase() !== method.maxTransactionCurrency.toUpperCase()) {
      checkAmount = (await convertFiat(paymentAmount, paymentCurrency, method.maxTransactionCurrency)).convertedAmount;
    }
    if (checkAmount > method.maxTransaction) {
      throw new Error(`Order exceeds ${method.maxTransaction} ${method.maxTransactionCurrency} limit for ${method.name}.`);
    }
  }

  const published = await publishOrderReceipt({
    storeUrl: input.storeUrl,
    relayList: input.relayList,
    orderId,
    items: input.items,
    subtotal: subtotalCents,
    shipping: shippingCents,
    total: totalCents,
    buyer: input.buyer,
    paymentMethod: method.id,
    paymentCurrency,
    paymentAmount: Math.round(paymentAmount * 100),
  }, relayClient);

  const formattedAmount = formatCurrency(paymentAmount, paymentCurrency);
  return {
    flow: 'manual',
    quote,
    published,
    method: {
      id: method.id,
      name: method.name,
      type: method.type,
      color: method.color,
    },
    paymentCurrency,
    paymentAmount,
    formattedAmount,
    instructions: method.checkoutInstructions(selected.address, context.lookupHash === published.order.storeId ? published.order.orderId : orderId, formattedAmount),
    exchangeRate,
    qrValue: selected.qrValue,
  };
}
