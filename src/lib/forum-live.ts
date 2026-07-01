import { decode, type ForumData } from '@nowhere/codec';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  encrypt as nip44Encrypt,
  decrypt as nip44Decrypt,
  getConversationKey,
} from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools/core';
import { describeSecret, type SecretMaterial } from './keys.js';
import { fetchEvent, fetchEvents, getForumRelays, publishToRelays } from './relay.js';
import { normalizeToFragment } from './fragments.js';

const encoder = new TextEncoder();
const NOWHERE_SIGNING_KEY = sha256(encoder.encode('nowhere-forum-signing-v1'));
const NOWHERE_SIGNING_PUBKEY = getPublicKey(NOWHERE_SIGNING_KEY);
const NOWHERE_CONV_KEY = getConversationKey(NOWHERE_SIGNING_KEY, NOWHERE_SIGNING_PUBKEY);
const NOWHERE_PREFIX = 'Signed for nowhere - nowhr.xyz\n';
const INNER_EVENT_KIND = 21423;
export const TORRENT_TOPIC_SEED = '41cae9db12fee677b38146d20fb2f6bb8828557a6db6692d3d6b1ee8f9d3bb06';

export interface ForumContext {
  fragment: string;
  data: ForumData;
  forumPrivkey: Uint8Array;
  forumPubkeyHex: string;
  relays: string[];
}

export interface ForumPostPayload {
  v: number;
  t: string;
  b?: string;
  l?: string;
  p: string;
  ts: number;
  sig: string;
  w?: string;
}

export interface ForumReplyPayload {
  v: number;
  b: string;
  p: string;
  ts: number;
  sig: string;
  w?: string;
  ref?: string;
}

export interface TorrentData {
  x: string;
  title: string;
  description?: string;
  files: { path: string; size: number }[];
  trackers: string[];
  category: string;
  refs: string[];
}

export interface ForumTorrentPayload {
  v: number;
  p: string;
  ts: number;
  sig: string;
  w: string;
}

export interface DecryptedForumPost {
  eventId: string;
  topic: string;
  topicTag: string;
  postTag: string;
  replyPubkey: string;
  payload: ForumPostPayload;
}

export interface DecryptedForumReply {
  eventId: string;
  postTag: string;
  payload: ForumReplyPayload;
}

export interface ChatMessagePayload {
  v: number;
  b: string;
  p: string;
  sp?: string;
  ts: number;
  sig: string;
  w?: string;
  room?: string | { name: string; code: string };
}

export interface DecryptedChatMessage {
  eventId: string;
  payload: ChatMessagePayload;
  channel: 'general';
}

export interface DecryptedForumTorrent {
  eventId: string;
  topicTag: string;
  authorPubkey: string;
  torrentData: TorrentData;
  wrappedContent: string;
}

function deriveForumKeypair(fragment: string) {
  const privkey = hmac(sha256, encoder.encode('nowhere-forum'), encoder.encode(fragment));
  return { privkey, pubkey: getPublicKey(privkey) };
}

function deriveTopicTag(forumPrivkey: Uint8Array, topicName: string): string {
  const input = new Uint8Array([
    ...encoder.encode('nowhere-forum-topic'),
    ...forumPrivkey,
    ...encoder.encode(topicName),
  ]);
  return bytesToHex(sha256(input)).slice(0, 32);
}

function deriveChatTag(forumPrivkey: Uint8Array): string {
  const input = new Uint8Array([
    ...encoder.encode('nowhere-forum-chat'),
    ...forumPrivkey,
  ]);
  return bytesToHex(sha256(input)).slice(0, 32);
}

function derivePostTag(postText: string, authorPubkey: string, timestamp: number): string {
  const input = new Uint8Array([
    ...encoder.encode(postText),
    ...encoder.encode(authorPubkey),
    ...encoder.encode(String(timestamp)),
  ]);
  return bytesToHex(sha256(input)).slice(0, 32);
}

function deriveReplyKeypair(postText: string, authorPubkey: string, timestamp: number) {
  const input = new Uint8Array([
    ...encoder.encode(postText),
    ...encoder.encode(authorPubkey),
    ...encoder.encode(String(timestamp)),
  ]);
  const privkey = hmac(sha256, encoder.encode('nowhere-reply'), input);
  return { privkey, pubkey: getPublicKey(privkey) };
}

function deriveTorrentReplyKeypair(wrappedContent: string) {
  const privkey = hmac(sha256, encoder.encode('nowhere-torrent-reply'), encoder.encode(wrappedContent));
  return { privkey, pubkey: getPublicKey(privkey) };
}

function deriveTorrentPostTag(wrappedContent: string): string {
  return bytesToHex(sha256(encoder.encode(wrappedContent))).slice(0, 32);
}

function wrapContentForSigning(content: string): string {
  const encrypted = nip44Encrypt(content, NOWHERE_CONV_KEY);
  return NOWHERE_PREFIX + encrypted;
}

function buildTopicEntries(context: ForumContext): Array<{ name: string; tag: string }> {
  const rawTopics = context.data.tags.find((tag) => tag.key === 'O')?.value ?? '';
  const topics = rawTopics ? rawTopics.split('\\p').filter(Boolean) : [];
  const names = [''].concat(topics);
  return names.map((name) => ({
    name,
    tag: deriveTopicTag(context.forumPrivkey, name),
  }));
}

function resolveAuthor(secret?: string): SecretMaterial | { pubkeyHex: string; secretKey: Uint8Array } {
  if (secret) {
    return describeSecret(secret);
  }

  const secretKey = generateSecretKey();
  return {
    secretKey,
    pubkeyHex: getPublicKey(secretKey),
  };
}

function createContext(input: string, relayOverride?: string[]): ForumContext {
  const { fragment } = normalizeToFragment(input);
  const decoded = decode(fragment);
  if (decoded.siteType !== 'discussion') {
    throw new Error('Expected a forum URL or fragment.');
  }
  const forumData = decoded as ForumData;
  const { privkey, pubkey } = deriveForumKeypair(fragment);
  return {
    fragment,
    data: forumData,
    forumPrivkey: privkey,
    forumPubkeyHex: pubkey,
    relays: relayOverride && relayOverride.length > 0 ? relayOverride : getForumRelays(forumData.tags),
  };
}

export function getForumContext(input: string, relayOverride?: string[]): ForumContext {
  return createContext(input, relayOverride);
}

export function getTopicTagMap(input: string): Array<{ topic: string; topicTag: string }> {
  const context = createContext(input);
  return buildTopicEntries(context).map((entry) => ({
    topic: entry.name,
    topicTag: entry.tag,
  }));
}

export function getChatTag(input: string): string {
  return deriveChatTag(createContext(input).forumPrivkey);
}

export async function publishForumPostFromInput(options: {
  forumInput: string;
  topic?: string;
  title: string;
  body?: string;
  link?: string;
  secret?: string;
  relays?: string[];
}) {
  const context = createContext(options.forumInput, options.relays);
  const topic = options.topic ?? '';
  const topicTag = deriveTopicTag(context.forumPrivkey, topic);
  const author = resolveAuthor(options.secret);
  const timestamp = Math.floor(Date.now() / 1000);
  const wrappedContent = wrapContentForSigning(
    JSON.stringify({ t: options.title, b: options.body ?? null, l: options.link ?? null, ts: timestamp }),
  );
  const inner = finalizeEvent(
    { kind: INNER_EVENT_KIND, created_at: timestamp, content: wrappedContent, tags: [] },
    author.secretKey,
  );

  const payload: ForumPostPayload = {
    v: 1,
    t: options.title,
    p: author.pubkeyHex,
    ts: timestamp,
    sig: inner.sig,
    w: wrappedContent,
  };
  if (options.body) {
    payload.b = options.body;
  }
  if (options.link) {
    payload.l = options.link;
  }

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, context.forumPubkeyHex);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 30078, created_at: timestamp, content: encrypted, tags: [['t', topicTag]] },
    outerSecret,
  );
  await publishToRelays(event, context.relays);

  const postTag = derivePostTag(options.body ?? '', author.pubkeyHex, timestamp);
  const replyKeypair = deriveReplyKeypair(options.body ?? '', author.pubkeyHex, timestamp);
  return {
    event,
    topic,
    topicTag,
    postTag,
    replyPubkey: replyKeypair.pubkey,
    authorPubkeyHex: author.pubkeyHex,
  };
}

function decryptPost(event: Event, context: ForumContext, topicTag: string): DecryptedForumPost | null {
  try {
    const conversationKey = getConversationKey(context.forumPrivkey, event.pubkey);
    const decrypted = nip44Decrypt(event.content, conversationKey);
    const payload = JSON.parse(decrypted) as ForumPostPayload;
    if (payload.v !== 1 || !payload.t || !payload.p || !payload.ts) {
      return null;
    }

    const postTag = derivePostTag(payload.b ?? '', payload.p, payload.ts);
    const replyKeypair = deriveReplyKeypair(payload.b ?? '', payload.p, payload.ts);
    const topicName = buildTopicEntries(context).find((entry) => entry.tag === topicTag)?.name ?? '';

    return {
      eventId: event.id,
      topic: topicName,
      topicTag,
      postTag,
      replyPubkey: replyKeypair.pubkey,
      payload,
    };
  } catch {
    return null;
  }
}

export async function listForumPosts(options: {
  forumInput: string;
  topic?: string;
  relays?: string[];
}) {
  const context = createContext(options.forumInput, options.relays);
  const topicEntries = buildTopicEntries(context);
  const targetEntries = options.topic !== undefined
    ? topicEntries.filter((entry) => entry.name === options.topic)
    : topicEntries.filter((entry) => entry.name !== TORRENT_TOPIC_SEED);

  const topicTags = targetEntries.map((entry) => entry.tag);
  const events = await fetchEvents({ kinds: [30078], '#t': topicTags }, context.relays);
  return events
    .map((event) => {
      const topicTag = event.tags.find((tag) => tag[0] === 't')?.[1];
      if (!topicTag) {
        return null;
      }
      return decryptPost(event, context, topicTag);
    })
    .filter((entry): entry is DecryptedForumPost => entry !== null)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}

export async function publishForumReplyFromInput(options: {
  forumInput: string;
  postEventId: string;
  body: string;
  quotedReplyId?: string;
  secret?: string;
  relays?: string[];
}) {
  const context = createContext(options.forumInput, options.relays);
  const postEvent = await fetchEvent({ ids: [options.postEventId] }, context.relays);
  if (!postEvent) {
    throw new Error(`Post ${options.postEventId} was not found on the configured relays.`);
  }

  const topicTag = postEvent.tags.find((tag) => tag[0] === 't')?.[1];
  if (!topicTag) {
    throw new Error('Post is missing a topic tag.');
  }

  const post = decryptPost(postEvent, context, topicTag);
  if (!post) {
    throw new Error('Could not decrypt the target post.');
  }

  const author = resolveAuthor(options.secret);
  const timestamp = Math.floor(Date.now() / 1000);
  const wrappedContent = wrapContentForSigning(JSON.stringify({ b: options.body, ts: timestamp }));
  const inner = finalizeEvent(
    { kind: INNER_EVENT_KIND, created_at: timestamp, content: wrappedContent, tags: [] },
    author.secretKey,
  );
  const payload: ForumReplyPayload = {
    v: 1,
    b: options.body,
    p: author.pubkeyHex,
    ts: timestamp,
    sig: inner.sig,
    w: wrappedContent,
    ref: options.quotedReplyId,
  };

  const replyKeypair = deriveReplyKeypair(post.payload.b ?? '', post.payload.p, post.payload.ts);
  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, replyKeypair.pubkey);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 30078, created_at: timestamp, content: encrypted, tags: [['t', post.postTag]] },
    outerSecret,
  );
  await publishToRelays(event, context.relays);
  return { event, postTag: post.postTag };
}

export async function listForumReplies(options: {
  forumInput: string;
  postEventId: string;
  relays?: string[];
}) {
  const context = createContext(options.forumInput, options.relays);
  const postEvent = await fetchEvent({ ids: [options.postEventId] }, context.relays);
  if (!postEvent) {
    throw new Error(`Post ${options.postEventId} was not found on the configured relays.`);
  }
  const topicTag = postEvent.tags.find((tag) => tag[0] === 't')?.[1];
  if (!topicTag) {
    throw new Error('Post is missing a topic tag.');
  }
  const post = decryptPost(postEvent, context, topicTag);
  if (!post) {
    throw new Error('Could not decrypt the target post.');
  }

  const replyKeypair = deriveReplyKeypair(post.payload.b ?? '', post.payload.p, post.payload.ts);
  const events = await fetchEvents({ kinds: [30078], '#t': [post.postTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(replyKeypair.privkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ForumReplyPayload;
        if (payload.v !== 1 || !payload.b || !payload.p) {
          return null;
        }
        return {
          eventId: event.id,
          postTag: post.postTag,
          payload,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is DecryptedForumReply => entry !== null)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}

export async function publishForumTorrentFromInput(options: {
  forumInput: string;
  torrent: TorrentData;
  secret?: string;
  relays?: string[];
}) {
  const context = createContext(options.forumInput, options.relays);
  const author = resolveAuthor(options.secret);
  const topicTag = deriveTopicTag(context.forumPrivkey, TORRENT_TOPIC_SEED);
  const timestamp = Math.floor(Date.now() / 1000);
  const wrappedContent = wrapContentForSigning(JSON.stringify(options.torrent));
  const inner = finalizeEvent(
    { kind: INNER_EVENT_KIND, created_at: timestamp, content: wrappedContent, tags: [] },
    author.secretKey,
  );

  const payload: ForumTorrentPayload = {
    v: 1,
    p: author.pubkeyHex,
    ts: timestamp,
    sig: inner.sig,
    w: wrappedContent,
  };

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, context.forumPubkeyHex);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 30078, created_at: timestamp, content: encrypted, tags: [['t', topicTag]] },
    outerSecret,
  );
  await publishToRelays(event, context.relays);
  return {
    event,
    topicTag,
    postTag: deriveTorrentPostTag(wrappedContent),
    replyPubkey: deriveTorrentReplyKeypair(wrappedContent).pubkey,
  };
}

export async function listForumTorrents(options: {
  forumInput: string;
  relays?: string[];
}) {
  const context = createContext(options.forumInput, options.relays);
  const topicTag = deriveTopicTag(context.forumPrivkey, TORRENT_TOPIC_SEED);
  const events = await fetchEvents({ kinds: [30078], '#t': [topicTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(context.forumPrivkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ForumTorrentPayload;
        if (!payload.w.startsWith(NOWHERE_PREFIX)) {
          return null;
        }
        const torrentJson = nip44Decrypt(payload.w.slice(NOWHERE_PREFIX.length), NOWHERE_CONV_KEY);
        const torrentData = JSON.parse(torrentJson) as TorrentData;
        return {
          eventId: event.id,
          topicTag,
          authorPubkey: payload.p,
          torrentData,
          wrappedContent: payload.w,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is DecryptedForumTorrent => entry !== null);
}

export async function publishGeneralChatMessage(options: {
  forumInput: string;
  message: string;
  secret?: string;
  relays?: string[];
}) {
  const context = createContext(options.forumInput, options.relays);
  const author = resolveAuthor(options.secret);
  const timestamp = Math.floor(Date.now() / 1000);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const wrappedContent = wrapContentForSigning(options.message);
  const inner = finalizeEvent(
    { kind: INNER_EVENT_KIND, created_at: timestamp, content: wrappedContent, tags: [] },
    author.secretKey,
  );
  const payload: ChatMessagePayload = {
    v: 1,
    b: options.message,
    p: author.pubkeyHex,
    ts: timestamp,
    sig: inner.sig,
    w: wrappedContent,
  };

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, context.forumPubkeyHex);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 21423, created_at: timestamp, content: encrypted, tags: [['t', chatTag]] },
    outerSecret,
  );
  await publishToRelays(event, context.relays);
  return { event, chatTag };
}

export async function listGeneralChatMessages(options: {
  forumInput: string;
  relays?: string[];
}) {
  const context = createContext(options.forumInput, options.relays);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const events = await fetchEvents({ kinds: [21423], '#t': [chatTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(context.forumPrivkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ChatMessagePayload;
        if (payload.v !== 1 || !payload.b || !payload.p) {
          return null;
        }
        return {
          eventId: event.id,
          payload,
          channel: 'general' as const,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is DecryptedChatMessage => entry !== null)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}
