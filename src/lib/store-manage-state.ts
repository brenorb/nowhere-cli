import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STORE_MANAGE_FILE = 'store-manage.json';

export type StoreOrderStatus = 'new' | 'confirmed' | 'processing' | 'fulfilled' | 'refunded' | 'no_payment';

export interface StoreManageRecord {
  orderStatuses: Record<string, StoreOrderStatus>;
  confirmedOrderIds: string[];
  hiddenOrderIds: string[];
  orderNotes: Record<string, string>;
}

interface StoreManageState {
  stores: Record<string, StoreManageRecord>;
}

export interface StoreOrderOverlay {
  status: StoreOrderStatus;
  confirmed: boolean;
  hidden: boolean;
  note: string | null;
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
}

function statePath(): string {
  return join(configHome(), 'nowhere-cli', STORE_MANAGE_FILE);
}

function emptyRecord(): StoreManageRecord {
  return {
    orderStatuses: {},
    confirmedOrderIds: [],
    hiddenOrderIds: [],
    orderNotes: {},
  };
}

function normalizeRecord(record: Partial<StoreManageRecord> | undefined): StoreManageRecord {
  return {
    orderStatuses: { ...(record?.orderStatuses ?? {}) },
    confirmedOrderIds: [...new Set((record?.confirmedOrderIds ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))],
    hiddenOrderIds: [...new Set((record?.hiddenOrderIds ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))],
    orderNotes: Object.fromEntries(
      Object.entries(record?.orderNotes ?? {})
        .map(([key, value]) => [key.trim().toLowerCase(), String(value)])
        .filter(([key]) => key.length > 0),
    ),
  };
}

async function readState(): Promise<StoreManageState> {
  try {
    const raw = await readFile(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreManageState>;
    const stores = Object.fromEntries(
      Object.entries(parsed.stores ?? {}).map(([storeId, record]) => [storeId, normalizeRecord(record)]),
    );
    return { stores };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { stores: {} };
    }
    return { stores: {} };
  }
}

async function writeState(state: StoreManageState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function getStoreManageRecord(storeId: string): Promise<StoreManageRecord> {
  const state = await readState();
  return normalizeRecord(state.stores[storeId]) ?? emptyRecord();
}

async function updateStoreRecord(
  storeId: string,
  updater: (record: StoreManageRecord) => void,
): Promise<StoreManageRecord> {
  const normalizedStoreId = storeId.trim().toLowerCase();
  const state = await readState();
  const record = normalizeRecord(state.stores[normalizedStoreId]);
  updater(record);
  state.stores[normalizedStoreId] = normalizeRecord(record);
  await writeState(state);
  return state.stores[normalizedStoreId] as StoreManageRecord;
}

export function getStoreOrderOverlay(record: StoreManageRecord, orderId: string): StoreOrderOverlay {
  const normalizedOrderId = orderId.trim().toLowerCase();
  return {
    status: record.orderStatuses[normalizedOrderId] ?? 'new',
    confirmed: record.confirmedOrderIds.includes(normalizedOrderId),
    hidden: record.hiddenOrderIds.includes(normalizedOrderId),
    note: record.orderNotes[normalizedOrderId] ?? null,
  };
}

export async function setStoreOrderStatus(
  storeId: string,
  orderIds: string[],
  status: StoreOrderStatus,
): Promise<StoreManageRecord> {
  return updateStoreRecord(storeId, (record) => {
    for (const orderId of orderIds.map((value) => value.trim().toLowerCase()).filter(Boolean)) {
      record.orderStatuses[orderId] = status;
    }
  });
}

export async function confirmStoreOrders(storeId: string, orderIds: string[]): Promise<StoreManageRecord> {
  return updateStoreRecord(storeId, (record) => {
    for (const orderId of orderIds.map((value) => value.trim().toLowerCase()).filter(Boolean)) {
      if (!record.confirmedOrderIds.includes(orderId)) {
        record.confirmedOrderIds.push(orderId);
      }
      if (!record.orderStatuses[orderId] || record.orderStatuses[orderId] === 'new') {
        record.orderStatuses[orderId] = 'confirmed';
      }
    }
  });
}

export async function unconfirmStoreOrders(storeId: string, orderIds: string[]): Promise<StoreManageRecord> {
  return updateStoreRecord(storeId, (record) => {
    const orderIdSet = new Set(orderIds.map((value) => value.trim().toLowerCase()).filter(Boolean));
    record.confirmedOrderIds = record.confirmedOrderIds.filter((orderId) => !orderIdSet.has(orderId));
  });
}

export async function hideStoreOrders(storeId: string, orderIds: string[]): Promise<StoreManageRecord> {
  return updateStoreRecord(storeId, (record) => {
    for (const orderId of orderIds.map((value) => value.trim().toLowerCase()).filter(Boolean)) {
      if (!record.hiddenOrderIds.includes(orderId)) {
        record.hiddenOrderIds.push(orderId);
      }
    }
  });
}

export async function unhideStoreOrders(storeId: string, orderIds: string[]): Promise<StoreManageRecord> {
  return updateStoreRecord(storeId, (record) => {
    const orderIdSet = new Set(orderIds.map((value) => value.trim().toLowerCase()).filter(Boolean));
    record.hiddenOrderIds = record.hiddenOrderIds.filter((orderId) => !orderIdSet.has(orderId));
  });
}

export async function setStoreOrderNote(storeId: string, orderId: string, note: string): Promise<StoreManageRecord> {
  return updateStoreRecord(storeId, (record) => {
    const normalizedOrderId = orderId.trim().toLowerCase();
    if (!normalizedOrderId) {
      return;
    }
    if (note.trim().length === 0) {
      delete record.orderNotes[normalizedOrderId];
      return;
    }
    record.orderNotes[normalizedOrderId] = note;
  });
}

export function extractOrderIdsFromText(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\b([0-9a-f]{15})\b/gi), (match) => match[1].toLowerCase()))];
}

export async function reconcileStoreOrders(
  storeId: string,
  text: string,
  knownOrderIds: string[],
): Promise<{ matched: string[]; missing: string[]; record: StoreManageRecord }> {
  const extracted = extractOrderIdsFromText(text);
  const known = new Set(knownOrderIds.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const matched = extracted.filter((orderId) => known.has(orderId));
  const missing = extracted.filter((orderId) => !known.has(orderId));
  const record = await confirmStoreOrders(storeId, matched);
  return { matched, missing, record };
}
