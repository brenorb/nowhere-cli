import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const {
  confirmStoreOrders, getStoreManageRecord, getStoreOrderOverlay, hideStoreOrders,
  reconcileStoreOrders, setStoreOrderNote, setStoreOrderStatus, unconfirmStoreOrders,
} = await import(pathToFileURL(join(process.cwd(), 'src/lib/store-manage-state.ts')).href);

const config = await mkdtemp(join(tmpdir(), 'nowhere-store-bookkeeping-'));
process.env.XDG_CONFIG_HOME = config;
const store = 'fixture';
const order = '0123456789abcde';
const other = '123456789abcdef';

try {
  await setStoreOrderStatus(store, [order], 'fulfilled');
  let overlay = getStoreOrderOverlay(await confirmStoreOrders(store, [order]), order);
  assert.equal(overlay.status, 'fulfilled');
  assert.equal(overlay.confirmed, true);
  overlay = getStoreOrderOverlay(await unconfirmStoreOrders(store, [order]), order);
  assert.equal(overlay.status, 'fulfilled');
  assert.equal(overlay.confirmed, false);

  const reconciled = await reconcileStoreOrders(store, order.toUpperCase() + ' ' + other, [order]);
  assert.deepEqual(reconciled.matched, [order]);
  assert.deepEqual(reconciled.missing, [other]);
  assert.equal(getStoreOrderOverlay(reconciled.record, order).status, 'fulfilled');

  const [noted, hidden] = await Promise.all([
    setStoreOrderNote(store, order, 'fixture note'),
    hideStoreOrders(store, [order]),
  ]);
  assert.equal(getStoreOrderOverlay(noted, order).note, 'fixture note');
  assert.equal(getStoreOrderOverlay(hidden, order).hidden, true);
  overlay = getStoreOrderOverlay(await getStoreManageRecord(store), order);
  assert.notEqual(Boolean(overlay.note), overlay.hidden, 'Expected one lost update after concurrent writes');
  console.log('Both bookkeeping calls succeeded, but exactly one update was persisted.');
} finally {
  await rm(config, { recursive: true, force: true });
}
