import { base64urlToHex } from '@nowhere/codec';
import { nip19 } from 'nostr-tools';
import { fetchEvents, getForumProfileRelays } from './relay.js';
import { resolveSiteInput } from './fragments.js';

const MAX_WOT_DEPTH = 3;
const followGraphCache = new Map<string, Set<string>>();
const inFlightByPubkey = new Map<string, Promise<void>>();

export type ForumModerationScope = 'post' | 'reply' | 'chat' | 'torrent';

export interface ForumModerationConfig {
  creatorPubkeyHex: string;
  depth: number | null;
  bannedWords: string[];
  profileRelays: string[];
}

export interface ForumWotCheck {
  scope: ForumModerationScope;
  depth: number | null;
  profileRelays: string[];
  creatorPubkeyHex: string;
  authorPubkeyHex: string;
  allowed: boolean;
  bannedWords: string[];
  wotSize: number | null;
}

function depthTagForScope(scope: ForumModerationScope): string {
  switch (scope) {
    case 'post':
      return 'W';
    case 'reply':
      return '3';
    case 'chat':
      return '4';
    case 'torrent':
      return '5';
  }
}

function parsePubkeyInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'npub') {
      throw new Error('Expected an npub public key.');
    }
    return decoded.data as string;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  throw new Error('Author public key must be a 64-character hex key or an npub.');
}

async function ensureFollowLists(pubkeys: string[], relays: string[]): Promise<void> {
  const toAwait: Promise<void>[] = [];
  const toFetch: string[] = [];

  for (const pubkey of pubkeys) {
    if (followGraphCache.has(pubkey)) {
      continue;
    }
    const inFlight = inFlightByPubkey.get(pubkey);
    if (inFlight) {
      toAwait.push(inFlight);
      continue;
    }
    toFetch.push(pubkey);
  }

  if (toFetch.length > 0) {
    const fetchPromise = (async () => {
      const events = await fetchEvents({ kinds: [3], authors: toFetch }, relays).catch(() => []);
      const latestByAuthor = new Map<string, { tags: string[][]; created_at: number }>();
      for (const event of events) {
        const existing = latestByAuthor.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
          latestByAuthor.set(event.pubkey, { tags: event.tags, created_at: event.created_at });
        }
      }

      for (const pubkey of toFetch) {
        const follows = new Set<string>();
        for (const tag of latestByAuthor.get(pubkey)?.tags ?? []) {
          if (tag[0] === 'p' && tag[1]) {
            follows.add(tag[1]);
          }
        }
        followGraphCache.set(pubkey, follows);
        inFlightByPubkey.delete(pubkey);
      }
    })();

    for (const pubkey of toFetch) {
      inFlightByPubkey.set(pubkey, fetchPromise);
    }
    toAwait.push(fetchPromise);
  }

  if (toAwait.length > 0) {
    await Promise.all(toAwait);
  }
}

export async function getForumModerationConfig(
  forumInput: string,
  scope: ForumModerationScope,
  profileRelays?: string[],
): Promise<ForumModerationConfig> {
  const resolved = await resolveSiteInput(forumInput);
  if (!resolved.siteData || resolved.siteData.siteType !== 'discussion') {
    throw new Error('Expected a Nowhere forum URL or fragment.');
  }
  if (!resolved.siteData.pubkey) {
    throw new Error('Forum is missing an owner pubkey.');
  }

  const depthRaw = resolved.siteData.tags.find((tag) => tag.key === depthTagForScope(scope))?.value;
  const depth = depthRaw !== undefined ? Number.parseInt(depthRaw, 10) : null;
  return {
    creatorPubkeyHex: base64urlToHex(resolved.siteData.pubkey),
    depth: Number.isNaN(depth ?? NaN) ? null : depth,
    bannedWords: (resolved.siteData.tags.find((tag) => tag.key === 'X')?.value ?? '')
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean),
    profileRelays: profileRelays && profileRelays.length > 0 ? profileRelays : getForumProfileRelays(resolved.siteData.tags),
  };
}

export async function buildForumWotSet(config: ForumModerationConfig): Promise<Set<string> | null> {
  if (config.depth === null) {
    return null;
  }

  const allowed = new Set<string>([config.creatorPubkeyHex]);
  const depth = Math.min(config.depth, MAX_WOT_DEPTH);
  if (depth === 0) {
    return allowed;
  }

  let frontier = new Set<string>([config.creatorPubkeyHex]);
  const consumed = new Set<string>();

  for (let currentDepth = 0; currentDepth < depth; currentDepth += 1) {
    const toProcess = [...frontier].filter((pubkey) => !consumed.has(pubkey));
    if (toProcess.length === 0) {
      break;
    }

    await ensureFollowLists(toProcess, config.profileRelays);
    for (const pubkey of toProcess) {
      consumed.add(pubkey);
    }

    const nextFrontier = new Set<string>();
    for (const pubkey of toProcess) {
      for (const followed of followGraphCache.get(pubkey) ?? []) {
        if (allowed.has(followed)) {
          continue;
        }
        allowed.add(followed);
        nextFrontier.add(followed);
      }
    }

    frontier = nextFrontier;
    if (frontier.size === 0) {
      break;
    }
  }

  return allowed;
}

export function passesForumModeration(authorPubkey: string, text: string, wotSet: Set<string> | null, bannedWords: string[]): boolean {
  if (wotSet && !wotSet.has(authorPubkey)) {
    return false;
  }

  const lower = text.toLowerCase();
  return !bannedWords.some((word) => word && lower.includes(word.toLowerCase()));
}

export async function checkForumWotAccess(input: {
  forumInput: string;
  scope: ForumModerationScope;
  author: string;
  profileRelays?: string[];
}): Promise<ForumWotCheck> {
  const config = await getForumModerationConfig(input.forumInput, input.scope, input.profileRelays);
  const wotSet = await buildForumWotSet(config);
  const authorPubkeyHex = parsePubkeyInput(input.author);
  return {
    scope: input.scope,
    depth: config.depth,
    profileRelays: config.profileRelays,
    creatorPubkeyHex: config.creatorPubkeyHex,
    authorPubkeyHex,
    allowed: !wotSet || wotSet.has(authorPubkeyHex),
    bannedWords: config.bannedWords,
    wotSize: wotSet?.size ?? null,
  };
}
