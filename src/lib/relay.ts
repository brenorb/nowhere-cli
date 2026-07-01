import type { Tag } from '@nowhere/codec';
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

export const NOWHERE_DTAG_PREFIX = 'nowhr';
export const NOWHERE_T_TAG = 'nowhr';

export const DEFAULT_INVENTORY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nostr.mom',
];

export const DEFAULT_ORDER_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
];

export const DEFAULT_FORUM_EVENT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
];

export const DEFAULT_FORUM_PROFILE_RELAYS = [
  'wss://relay.damus.io',
  'wss://nostr.bitcoiner.social',
  'wss://user.kindpag.es',
  'wss://purplerelay.com',
];

export const DEFAULT_PETITION_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

let pool: SimplePool | null = null;

export function getPool(): SimplePool {
  if (!pool) {
    pool = new SimplePool();
  }
  return pool;
}

export function destroyPool(): void {
  if (!pool) {
    return;
  }

  pool.destroy();
  pool = null;
}

export async function fetchEvent(filter: Filter, relays: string[]): Promise<Event | null> {
  return getPool().get(relays, filter);
}

export async function fetchEvents(filter: Filter, relays: string[]): Promise<Event[]> {
  return getPool().querySync(relays, filter);
}

export async function countEvents(filter: Filter, relays: string[]): Promise<number> {
  const relayCounts = await Promise.allSettled(
    relays.map(async (relayUrl) => {
      const relay = await getPool().ensureRelay(relayUrl);
      return relay.count([filter], {});
    }),
  );

  const successful = relayCounts
    .filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled')
    .map((result) => result.value);
  if (successful.length > 0) {
    return Math.max(...successful);
  }

  return (await fetchEvents(filter, relays)).length;
}

export async function publishToRelays(event: Event, relays: string[]): Promise<void> {
  const dedupedRelays = [...new Set(relays)];
  const publishResults = await Promise.allSettled(getPool().publish(dedupedRelays, event));
  const successCount = publishResults.filter((result) => {
    if (result.status !== 'fulfilled') {
      return false;
    }
    return !String(result.value).startsWith('connection failure');
  }).length;

  if (successCount === 0) {
    throw new Error('Failed to publish to any relay.');
  }
}

function getRelaysFromTag(tags: Tag[], key: string): string[] {
  const tag = tags.find((entry) => entry.key === key);
  if (!tag?.value) {
    return [];
  }
  return tag.value.split(',').map((relay) => relay.trim()).filter(Boolean);
}

export function getInventoryRelays(storeTags: Tag[]): string[] {
  return getRelaysFromTag(storeTags, '1').length > 0
    ? getRelaysFromTag(storeTags, '1')
    : [...DEFAULT_INVENTORY_RELAYS];
}

export function getOrderRelays(storeTags: Tag[]): string[] {
  return getRelaysFromTag(storeTags, '2').length > 0
    ? getRelaysFromTag(storeTags, '2')
    : [...DEFAULT_ORDER_RELAYS];
}

export function getForumRelays(forumTags: Tag[]): string[] {
  return getRelaysFromTag(forumTags, '1').length > 0
    ? getRelaysFromTag(forumTags, '1')
    : [...DEFAULT_FORUM_EVENT_RELAYS];
}

export function getForumProfileRelays(forumTags: Tag[]): string[] {
  return getRelaysFromTag(forumTags, '2').length > 0
    ? getRelaysFromTag(forumTags, '2')
    : [...DEFAULT_FORUM_PROFILE_RELAYS];
}

export function getPetitionRelays(petitionTags: Tag[]): string[] {
  return getRelaysFromTag(petitionTags, '1').length > 0
    ? getRelaysFromTag(petitionTags, '1')
    : [...DEFAULT_PETITION_RELAYS];
}
