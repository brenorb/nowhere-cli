import type { Item, StoreData } from '@nowhere/codec';
import type { FetchedOrders, OrderMessage } from './store-live.js';
import type { FetchPetitionSignaturesResult, PetitionSignaturePayload } from './petition-live.js';

function csvCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatAmount(cents: number | undefined): string {
  if (typeof cents !== 'number' || Number.isNaN(cents)) {
    return '';
  }
  return (cents / 100).toFixed(2);
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function itemsSummary(order: OrderMessage, items: Item[] | undefined): string {
  if (!items) {
    return `${order.items.length} item${order.items.length === 1 ? '' : 's'}`;
  }

  return order.items.map((orderItem) => {
    const item = items[orderItem.i];
    const name = item?.name ?? `Item #${orderItem.i}`;
    return orderItem.qty > 1 ? `${orderItem.qty}× ${name}` : name;
  }).join(', ');
}

export function formatStoreOrdersCsv(
  fetched: FetchedOrders,
  storeData?: StoreData,
): string {
  const knownBuyerKeys = ['name', 'email', 'phone', 'street', 'city', 'state', 'postal', 'country', 'nostr', 'notes'];
  const extraKeys = new Set<string>();
  for (const { order } of fetched.orders) {
    for (const key of Object.keys(order.buyer ?? {})) {
      if (!knownBuyerKeys.includes(key)) {
        extraKeys.add(key);
      }
    }
  }
  const extraKeyColumns = [...extraKeys].sort();
  const headers = [
    'Date',
    'Order ID',
    'Store',
    'Status',
    'Confirmed',
    'Name',
    'Email',
    'Phone',
    'Street',
    'City',
    'State',
    'Postal',
    'Country',
    'Nostr',
    'Notes',
    'Items',
    'Subtotal',
    'Shipping',
    'Total',
    'Store Currency',
    'Payment Method',
    'Payment Currency',
    'Payment Amount',
    ...extraKeyColumns,
  ];

  const rows = fetched.orders.map(({ order }) => {
    const buyer = order.buyer ?? {};
    return [
      formatDate(order.timestamp),
      order.orderId,
      storeData?.name ?? fetched.context.lookupHash,
      '',
      '',
      buyer.name ?? '',
      buyer.email ?? '',
      buyer.phone ?? '',
      buyer.street ?? '',
      buyer.city ?? '',
      buyer.state ?? '',
      buyer.postal ?? '',
      buyer.country ?? '',
      buyer.nostr ?? '',
      buyer.notes ?? '',
      itemsSummary(order, storeData?.items),
      formatAmount(order.subtotal),
      formatAmount(order.shipping),
      formatAmount(order.total),
      storeData?.tags.find((tag) => tag.key === '$')?.value ?? '',
      order.paymentMethod ?? '',
      order.paymentCurrency ?? '',
      typeof order.paymentAmount === 'number' ? formatAmount(order.paymentAmount) : '',
      ...extraKeyColumns.map((key) => String(buyer[key] ?? '')),
    ];
  });

  return [headers, ...rows]
    .map((row) => row.map((cell) => csvCell(String(cell))).join(','))
    .join('\n');
}

export function formatPetitionSignaturesCsv(
  fetched: FetchPetitionSignaturesResult<PetitionSignaturePayload>,
): string {
  const headers = ['Signed At', 'Name', 'Email', 'Location', 'Street', 'City', 'State/Province', 'Postcode', 'Addr Country', 'Phone', 'Npub', 'Organisation', 'Comment', 'Country', 'Pubkey'];
  const rows = fetched.signatures
    .filter((signature) => signature.payload && !signature.decryptError)
    .map((signature) => {
      const payload = signature.payload as Record<string, unknown>;
      const tsValue = typeof payload.ts === 'number'
        ? new Date(payload.ts).toISOString()
        : formatDate(signature.createdAt);
      return [
        tsValue,
        String(payload.name ?? ''),
        String(payload.email ?? ''),
        String(payload.address ?? ''),
        String(payload.street ?? ''),
        String(payload.city ?? ''),
        String(payload.addrState ?? ''),
        String(payload.postal ?? ''),
        String(payload.addrCountry ?? ''),
        String(payload.phone ?? ''),
        String(payload.npub ?? ''),
        String(payload.org ?? ''),
        String(payload.comment ?? ''),
        String(payload.country ?? ''),
        signature.pubkey,
      ];
    });

  return [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}
