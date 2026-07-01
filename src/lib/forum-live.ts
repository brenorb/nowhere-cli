import { decode, type ForumData } from '@nowhere/codec';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  encrypt as nip44Encrypt,
  decrypt as nip44Decrypt,
  getConversationKey,
} from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { Event } from 'nostr-tools/core';
import type { CliSigner } from './active-signer.js';
import { describeSecret, type SecretMaterial } from './keys.js';
import { getForumSessionMaterial } from './forum-session.js';
import { fetchEvent, fetchEvents, getForumRelays, publishToRelays, publishToRelaysBestEffort } from './relay.js';
import { normalizeToFragment } from './fragments.js';
import type { ParsedTorrentFile } from './torrent-bencode.js';

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

interface AuthorIdentity {
  pubkeyHex: string;
  secretKey?: Uint8Array;
  signer?: CliSigner;
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

export type VoiceSignalType = 'join' | 'leave' | 'offer' | 'answer' | 'ice' | 'mute';

export interface VoiceSignalPayload {
  v: 1;
  voice: true;
  type: VoiceSignalType;
  p: string;
  ap?: string;
  ch: string;
  ts: number;
  target?: string;
  sdp?: string;
  candidate?: string;
  muted?: boolean;
  sig?: string;
  w?: string;
}

export interface DecryptedChatMessage {
  eventId: string;
  payload: ChatMessagePayload;
  channel: 'general' | 'room' | 'private';
  roomName?: string;
  peerPubkey?: string;
}

export interface DecryptedVoiceSignal {
  eventId: string;
  payload: VoiceSignalPayload;
  channel: 'general' | 'room' | 'private';
  roomName?: string;
  peerPubkey?: string;
  joinSignatureValid: boolean;
}

export interface DecryptedRoomAnnouncement {
  eventId: string;
  payload: ChatMessagePayload;
  roomName: string;
  accessCode: string;
}

export interface DecryptedForumTorrent {
  eventId: string;
  topicTag: string;
  authorPubkey: string;
  timestamp: number;
  torrentData: TorrentData;
  wrappedContent: string;
  magnetLink: string;
}

export interface ForumTorrentSettings {
  enabled: boolean;
  topCategories: string[];
  categoriesFixed: boolean;
  rules: string;
}

export interface ForumTorrentDuplicate {
  reason: 'infohash' | 'title';
  eventId: string;
  title: string;
}

export interface CheckedForumTorrentSubmission {
  settings: ForumTorrentSettings;
  torrent: TorrentData;
  duplicate: ForumTorrentDuplicate | null;
}

const VOICE_SIGNAL_TYPES = new Set<VoiceSignalType>(['join', 'leave', 'offer', 'answer', 'ice', 'mute']);

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

function deriveRoomKeypair(forumPrivkey: Uint8Array, roomName: string, accessCode: string) {
  const message = new Uint8Array([
    ...forumPrivkey,
    ...encoder.encode(roomName),
    0,
    ...encoder.encode(accessCode),
  ]);
  const privkey = hmac(sha256, encoder.encode('nowhere-chat-room'), message);
  return { privkey, pubkey: getPublicKey(privkey) };
}

function wrapContentForSigning(content: string): string {
  const encrypted = nip44Encrypt(content, NOWHERE_CONV_KEY);
  return NOWHERE_PREFIX + encrypted;
}

function verifyInnerSignature(pubkey: string, sig: string, wrappedContent: string, timestamp: number): boolean {
  const event = {
    kind: INNER_EVENT_KIND,
    created_at: timestamp,
    content: wrappedContent,
    tags: [] as string[][],
    pubkey,
    sig,
    id: '',
  };
  event.id = getEventHash(event);
  return verifyEvent(event);
}

function randomTimestampOffset(): number {
  return -Math.floor(Math.random() * 4 * 86_400);
}

export function buildMagnetLink(torrent: TorrentData): string {
  let url = `magnet:?xt=urn:btih:${torrent.x}&dn=${encodeURIComponent(torrent.title)}`;
  for (const tracker of torrent.trackers) {
    url += `&tr=${encodeURIComponent(tracker)}`;
  }
  return url;
}

function isRoomAnnouncementValue(room: ChatMessagePayload['room']): room is { name: string; code: string } {
  return typeof room === 'object' && room !== null && 'name' in room && 'code' in room;
}

function isHex64(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isVoiceSignalPayload(payload: unknown): payload is VoiceSignalPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  if (candidate.v !== 1 || candidate.voice !== true) {
    return false;
  }
  if (typeof candidate.type !== 'string' || !VOICE_SIGNAL_TYPES.has(candidate.type as VoiceSignalType)) {
    return false;
  }
  if (!isHex64(typeof candidate.p === 'string' ? candidate.p : undefined)) {
    return false;
  }
  if (candidate.ap !== undefined && !isHex64(typeof candidate.ap === 'string' ? candidate.ap : undefined)) {
    return false;
  }
  if (typeof candidate.ch !== 'string' || candidate.ch.length === 0) {
    return false;
  }
  if (typeof candidate.ts !== 'number') {
    return false;
  }
  if (candidate.target !== undefined && !isHex64(typeof candidate.target === 'string' ? candidate.target : undefined)) {
    return false;
  }
  if (candidate.sdp !== undefined && typeof candidate.sdp !== 'string') {
    return false;
  }
  if (candidate.candidate !== undefined && typeof candidate.candidate !== 'string') {
    return false;
  }
  if (candidate.muted !== undefined && typeof candidate.muted !== 'boolean') {
    return false;
  }
  if (candidate.sig !== undefined && typeof candidate.sig !== 'string') {
    return false;
  }
  if (candidate.w !== undefined && typeof candidate.w !== 'string') {
    return false;
  }
  return true;
}

function verifyJoinSignal(payload: VoiceSignalPayload): boolean {
  if (payload.type !== 'join') {
    return true;
  }
  if (!payload.sig || !payload.w || !payload.ap) {
    return false;
  }
  return verifyInnerSignature(payload.ap, payload.sig, payload.w, payload.ts);
}

function deriveVoiceChannel(channel: 'general' | 'room' | 'private', roomName?: string, peerPubkey?: string): string {
  if (channel === 'general') {
    return 'general';
  }
  if (channel === 'room') {
    if (!roomName) {
      throw new Error('Room voice signals require a room name.');
    }
    return `room:${roomName}`;
  }
  if (!peerPubkey) {
    throw new Error('Private voice signals require the peer author pubkey.');
  }
  return `private:${peerPubkey}`;
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

function getTagValue(tags: ForumData['tags'], key: string): string | undefined {
  return tags.find((tag) => tag.key === key)?.value;
}

function hasBooleanTag(tags: ForumData['tags'], key: string): boolean {
  return tags.some((tag) => tag.key === key && tag.value === undefined);
}

function normalizeCategory(category: string): string {
  return category
    .split('>')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
    .join(' > ');
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function getForumIdentityMode(data: ForumData): number {
  const parsed = Number.parseInt(getTagValue(data.tags, 'i') ?? '1', 10);
  return [0, 1, 2].includes(parsed) ? parsed : 1;
}

function getForumPostSizeLimit(data: ForumData): number {
  const raw = getTagValue(data.tags, 'm');
  const parsed = raw ? Number.parseInt(raw, 36) : 5000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

function buildForumPostText(title: string, body?: string): string {
  return title + (body ? ` ${body}` : '');
}

function enforceForumPostSizeLimit(data: ForumData, title: string, body?: string): void {
  const limit = getForumPostSizeLimit(data);
  if (buildForumPostText(title, body).length > limit) {
    throw new Error(`Forum posts exceed the configured size limit (${limit} characters).`);
  }
}

function enforceForumReplySizeLimit(data: ForumData, body: string): void {
  const limit = getForumPostSizeLimit(data);
  if (body.length > limit) {
    throw new Error(`Forum replies exceed the configured size limit (${limit} characters).`);
  }
}

function requireAllowedForumTopic(context: ForumContext, topic?: string): string {
  const resolvedTopic = topic ?? '';
  const allowedTopics = buildTopicEntries(context)
    .map((entry) => entry.name)
    .filter((entry) => entry !== TORRENT_TOPIC_SEED);
  if (!allowedTopics.includes(resolvedTopic)) {
    throw new Error(`Forum topic "${resolvedTopic}" is not enabled for this forum.`);
  }
  return resolvedTopic;
}

function getTorrentSettings(data: ForumData): ForumTorrentSettings {
  const topCategories = (getTagValue(data.tags, 'q') ?? 'Software|Video|Audio|Books')
    .split('|')
    .map((category) => category.trim().toLowerCase())
    .filter(Boolean);

  return {
    enabled: hasBooleanTag(data.tags, 'b'),
    topCategories,
    categoriesFixed: hasBooleanTag(data.tags, 'F'),
    rules: getTagValue(data.tags, 'h') ?? '',
  };
}

async function resolveForumAuthor(context: ForumContext, secret?: string, signer?: CliSigner): Promise<AuthorIdentity> {
  const identityMode = getForumIdentityMode(context.data);
  if (identityMode === 0 && !secret && !signer) {
    throw new Error('This forum requires a Nostr identity. Pass --secret or --use-signer.');
  }
  if (identityMode === 2 && (secret || signer)) {
    throw new Error('This forum only allows anonymous participation. Omit --secret and --use-signer.');
  }
  return resolveAuthor(secret, signer);
}

async function resolveAuthor(secret?: string, signer?: CliSigner): Promise<AuthorIdentity> {
  if (signer) {
    return {
      pubkeyHex: await signer.getPublicKey(),
      signer,
    };
  }
  if (secret) {
    return describeSecret(secret);
  }

  return getForumSessionMaterial();
}

async function signWrappedContent(author: AuthorIdentity, wrappedContent: string, timestamp: number): Promise<{ pubkeyHex: string; signature: string }> {
  if (author.signer) {
    const signed = await author.signer.signEvent({
      kind: INNER_EVENT_KIND,
      created_at: timestamp,
      content: wrappedContent,
      tags: [],
    });
    return {
      pubkeyHex: signed.pubkey,
      signature: signed.sig,
    };
  }

  const inner = finalizeEvent(
    { kind: INNER_EVENT_KIND, created_at: timestamp, content: wrappedContent, tags: [] },
    author.secretKey as Uint8Array,
  );
  return {
    pubkeyHex: author.pubkeyHex,
    signature: inner.sig,
  };
}

function resolveForumFragment(input: string): { fragment: string; data: ForumData } {
  const { fragment } = normalizeToFragment(input);
  try {
    const decoded = decode(fragment);
    if (decoded.siteType !== 'discussion') {
      throw new Error('Expected a forum URL or fragment.');
    }
    return {
      fragment,
      data: decoded as ForumData,
    };
  } catch {
    const rawBytes = Buffer.from(fragment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (rawBytes.length <= 64) {
      throw new Error('Expected a forum URL or fragment.');
    }

    const unsignedFragment = Buffer.from(rawBytes.subarray(0, rawBytes.length - 64))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const decoded = decode(unsignedFragment);
    if (decoded.siteType !== 'discussion') {
      throw new Error('Expected a forum URL or fragment.');
    }
    return {
      fragment: unsignedFragment,
      data: decoded as ForumData,
    };
  }
}

function createContext(input: string, relayOverride?: string[], salt?: string): ForumContext {
  const { fragment, data: forumData } = resolveForumFragment(input);
  const effectiveFragment = salt ? `${fragment}:${salt}` : fragment;
  const { privkey, pubkey } = deriveForumKeypair(effectiveFragment);
  return {
    fragment,
    data: forumData,
    forumPrivkey: privkey,
    forumPubkeyHex: pubkey,
    relays: relayOverride && relayOverride.length > 0 ? relayOverride : getForumRelays(forumData.tags),
  };
}

export function getForumContext(input: string, relayOverride?: string[], salt?: string): ForumContext {
  return createContext(input, relayOverride, salt);
}

export function getForumTorrentSettings(input: string, salt?: string): ForumTorrentSettings {
  return getTorrentSettings(createContext(input, undefined, salt).data);
}

export function getTopicTagMap(input: string, salt?: string): Array<{ topic: string; topicTag: string }> {
  const context = createContext(input, undefined, salt);
  return buildTopicEntries(context).map((entry) => ({
    topic: entry.name,
    topicTag: entry.tag,
  }));
}

export function getChatTag(input: string, salt?: string): string {
  return deriveChatTag(createContext(input, undefined, salt).forumPrivkey);
}

export async function publishForumPostFromInput(options: {
  forumInput: string;
  topic?: string;
  title: string;
  body?: string;
  link?: string;
  secret?: string;
  signer?: CliSigner;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const topic = requireAllowedForumTopic(context, options.topic);
  enforceForumPostSizeLimit(context.data, options.title, options.body);
  const topicTag = deriveTopicTag(context.forumPrivkey, topic);
  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const timestamp = Math.floor(Date.now() / 1000);
  const wrappedContent = wrapContentForSigning(
    JSON.stringify({ t: options.title, b: options.body ?? null, l: options.link ?? null, ts: timestamp }),
  );
  const inner = await signWrappedContent(author, wrappedContent, timestamp);

  const payload: ForumPostPayload = {
    v: 1,
    t: options.title,
    p: inner.pubkeyHex,
    ts: timestamp,
    sig: inner.signature,
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
    { kind: 30078, created_at: timestamp + randomTimestampOffset(), content: encrypted, tags: [['t', topicTag]] },
    outerSecret,
  );
  await publishToRelays(event, context.relays);

  const postTag = derivePostTag(options.title, inner.pubkeyHex, timestamp);
  const replyKeypair = deriveReplyKeypair(options.title, inner.pubkeyHex, timestamp);
  return {
    event,
    topic,
    topicTag,
    postTag,
    replyPubkey: replyKeypair.pubkey,
    authorPubkeyHex: inner.pubkeyHex,
  };
}

function decryptPost(event: Event, context: ForumContext, topicTag: string): DecryptedForumPost | null {
  try {
    const conversationKey = getConversationKey(context.forumPrivkey, event.pubkey);
    const decrypted = nip44Decrypt(event.content, conversationKey);
    const payload = JSON.parse(decrypted) as ForumPostPayload;
    if (payload.v !== 1 || !payload.t || !payload.p || !payload.ts || !payload.sig || !payload.w) {
      return null;
    }
    if (!verifyInnerSignature(payload.p, payload.sig, payload.w, payload.ts)) {
      return null;
    }

    const postTag = derivePostTag(payload.t, payload.p, payload.ts);
    const replyKeypair = deriveReplyKeypair(payload.t, payload.p, payload.ts);
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
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const topicEntries = buildTopicEntries(context);
  const targetEntries = options.topic !== undefined
    ? topicEntries.filter((entry) => entry.name === options.topic)
    : topicEntries.filter((entry) => entry.name !== TORRENT_TOPIC_SEED);
  const sizeLimit = getForumPostSizeLimit(context.data);

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
    .filter((entry) => buildForumPostText(entry.payload.t, entry.payload.b).length <= sizeLimit)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}

export async function publishForumReplyFromInput(options: {
  forumInput: string;
  postEventId: string;
  body: string;
  quotedReplyId?: string;
  secret?: string;
  signer?: CliSigner;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
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

  enforceForumReplySizeLimit(context.data, options.body);
  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const timestamp = Math.floor(Date.now() / 1000);
  const wrappedContent = wrapContentForSigning(JSON.stringify({ b: options.body, ts: timestamp }));
  const inner = await signWrappedContent(author, wrappedContent, timestamp);
  const payload: ForumReplyPayload = {
    v: 1,
    b: options.body,
    p: inner.pubkeyHex,
    ts: timestamp,
    sig: inner.signature,
    w: wrappedContent,
    ref: options.quotedReplyId,
  };

  const replyKeypair = deriveReplyKeypair(post.payload.t, post.payload.p, post.payload.ts);
  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, replyKeypair.pubkey);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 30078, created_at: timestamp + randomTimestampOffset(), content: encrypted, tags: [['t', post.postTag]] },
    outerSecret,
  );
  await publishToRelays(event, context.relays);
  return { event, postTag: post.postTag };
}

export async function listForumReplies(options: {
  forumInput: string;
  postEventId: string;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
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

  const replyKeypair = deriveReplyKeypair(post.payload.t, post.payload.p, post.payload.ts);
  const sizeLimit = getForumPostSizeLimit(context.data);
  const events = await fetchEvents({ kinds: [30078], '#t': [post.postTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(replyKeypair.privkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ForumReplyPayload;
        if (payload.v !== 1 || !payload.b || !payload.p || !payload.sig || !payload.w) {
          return null;
        }
        if (!verifyInnerSignature(payload.p, payload.sig, payload.w, payload.ts)) {
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
    .filter((entry) => entry.payload.b.length <= sizeLimit)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}

export async function publishForumTorrentFromInput(options: {
  forumInput: string;
  torrent: TorrentData;
  secret?: string;
  signer?: CliSigner;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const checked = await checkForumTorrentSubmission({
    forumInput: options.forumInput,
    torrent: options.torrent,
    relays: context.relays,
    salt: options.salt,
  });
  if (checked.duplicate) {
    throw new Error(`Torrent already exists (${checked.duplicate.reason} match: ${checked.duplicate.title}).`);
  }

  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const topicTag = deriveTopicTag(context.forumPrivkey, TORRENT_TOPIC_SEED);
  const timestamp = Math.floor(Date.now() / 1000);
  const wrappedContent = wrapContentForSigning(JSON.stringify(checked.torrent));
  const inner = await signWrappedContent(author, wrappedContent, timestamp);

  const payload: ForumTorrentPayload = {
    v: 1,
    p: inner.pubkeyHex,
    ts: timestamp,
    sig: inner.signature,
    w: wrappedContent,
  };

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, context.forumPubkeyHex);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 30078, created_at: timestamp + randomTimestampOffset(), content: encrypted, tags: [['t', topicTag]] },
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
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const topicTag = deriveTopicTag(context.forumPrivkey, TORRENT_TOPIC_SEED);
  const events = await fetchEvents({ kinds: [30078], '#t': [topicTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(context.forumPrivkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ForumTorrentPayload;
        if (payload.v !== 1 || !payload.p || !payload.sig || !payload.w) {
          return null;
        }
        if (!verifyInnerSignature(payload.p, payload.sig, payload.w, payload.ts)) {
          return null;
        }
        if (!payload.w.startsWith(NOWHERE_PREFIX)) {
          return null;
        }
        const torrentJson = nip44Decrypt(payload.w.slice(NOWHERE_PREFIX.length), NOWHERE_CONV_KEY);
        const torrentData = JSON.parse(torrentJson) as TorrentData;
        return {
          eventId: event.id,
          topicTag,
          authorPubkey: payload.p,
          timestamp: payload.ts,
          torrentData,
          wrappedContent: payload.w,
          magnetLink: buildMagnetLink(torrentData),
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is DecryptedForumTorrent => entry !== null);
}

export function buildTorrentDataFromParsedTorrent(parsed: ParsedTorrentFile, options: {
  title?: string;
  description?: string;
  trackers?: string[];
  refs?: string[];
  category: string;
}): TorrentData {
  const title = options.title?.trim() || parsed.title.trim();
  if (!title) {
    throw new Error('Torrent title is required.');
  }

  return {
    x: parsed.infohash,
    title,
    ...(options.description?.trim() ? { description: options.description.trim() } : {}),
    files: parsed.files,
    trackers: uniqueStrings(options.trackers && options.trackers.length > 0 ? options.trackers : parsed.trackers),
    category: normalizeCategory(options.category),
    refs: uniqueStrings(options.refs ?? []),
  };
}

export async function checkForumTorrentSubmission(options: {
  forumInput: string;
  torrent: TorrentData;
  relays?: string[];
  salt?: string;
}): Promise<CheckedForumTorrentSubmission> {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const settings = getTorrentSettings(context.data);
  if (!settings.enabled) {
    throw new Error('Torrent submissions are disabled for this forum.');
  }

  const category = normalizeCategory(options.torrent.category);
  if (!category) {
    throw new Error('Torrent category is required.');
  }
  const [rootCategory] = category.split(' > ');
  if (settings.categoriesFixed && rootCategory && !settings.topCategories.includes(rootCategory)) {
    throw new Error(`Torrent root category must be one of: ${settings.topCategories.join(', ')}.`);
  }

  const torrent: TorrentData = {
    ...options.torrent,
    title: options.torrent.title.trim(),
    description: options.torrent.description?.trim() || undefined,
    trackers: uniqueStrings(options.torrent.trackers),
    refs: uniqueStrings(options.torrent.refs),
    category,
  };
  if (!torrent.title) {
    throw new Error('Torrent title is required.');
  }

  const existing = await listForumTorrents({
    forumInput: options.forumInput,
    relays: context.relays,
    salt: options.salt,
  });
  const duplicateByHash = existing.find((entry) => entry.torrentData.x === torrent.x);
  const duplicateByTitle = existing.find((entry) => entry.torrentData.title.trim().toLowerCase() === torrent.title.toLowerCase());

  return {
    settings,
    torrent,
    duplicate: duplicateByHash
      ? { reason: 'infohash', eventId: duplicateByHash.eventId, title: duplicateByHash.torrentData.title }
      : duplicateByTitle
        ? { reason: 'title', eventId: duplicateByTitle.eventId, title: duplicateByTitle.torrentData.title }
        : null,
  };
}

export async function publishForumTorrentReplyFromInput(options: {
  forumInput: string;
  torrentEventId: string;
  body: string;
  quotedReplyId?: string;
  secret?: string;
  signer?: CliSigner;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const torrentEvent = await fetchEvent({ ids: [options.torrentEventId] }, context.relays);
  if (!torrentEvent) {
    throw new Error(`Torrent ${options.torrentEventId} was not found on the configured relays.`);
  }
  const torrents = await listForumTorrents({
    forumInput: options.forumInput,
    relays: context.relays,
    salt: options.salt,
  });
  const target = torrents.find((entry) => entry.eventId === options.torrentEventId);
  if (!target) {
    throw new Error('Could not decrypt the target torrent.');
  }

  enforceForumReplySizeLimit(context.data, options.body);
  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const timestamp = Math.floor(Date.now() / 1000);
  const wrappedContent = wrapContentForSigning(JSON.stringify({ b: options.body, ts: timestamp }));
  const inner = await signWrappedContent(author, wrappedContent, timestamp);
  const payload: ForumReplyPayload = {
    v: 1,
    b: options.body,
    p: inner.pubkeyHex,
    ts: timestamp,
    sig: inner.signature,
    w: wrappedContent,
    ref: options.quotedReplyId,
  };

  const postTag = deriveTorrentPostTag(target.wrappedContent);
  const replyKeypair = deriveTorrentReplyKeypair(target.wrappedContent);
  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, replyKeypair.pubkey);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 30078, created_at: timestamp + randomTimestampOffset(), content: encrypted, tags: [['t', postTag]] },
    outerSecret,
  );
  await publishToRelays(event, context.relays);
  return { event, postTag };
}

export async function listForumTorrentReplies(options: {
  forumInput: string;
  torrentEventId: string;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const torrents = await listForumTorrents({
    forumInput: options.forumInput,
    relays: context.relays,
    salt: options.salt,
  });
  const target = torrents.find((entry) => entry.eventId === options.torrentEventId);
  if (!target) {
    throw new Error('Could not decrypt the target torrent.');
  }

  const postTag = deriveTorrentPostTag(target.wrappedContent);
  const replyKeypair = deriveTorrentReplyKeypair(target.wrappedContent);
  const sizeLimit = getForumPostSizeLimit(context.data);
  const events = await fetchEvents({ kinds: [30078], '#t': [postTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(replyKeypair.privkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ForumReplyPayload;
        if (payload.v !== 1 || !payload.b || !payload.p || !payload.sig || !payload.w) {
          return null;
        }
        if (!verifyInnerSignature(payload.p, payload.sig, payload.w, payload.ts)) {
          return null;
        }
        return {
          eventId: event.id,
          postTag,
          payload,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is DecryptedForumReply => entry !== null)
    .filter((entry) => entry.payload.b.length <= sizeLimit)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}

export async function publishRoomAnnouncement(options: {
  forumInput: string;
  roomName: string;
  accessCode: string;
  secret?: string;
  signer?: CliSigner;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const timestamp = Math.floor(Date.now() / 1000);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const wrappedContent = wrapContentForSigning('room');
  const inner = await signWrappedContent(author, wrappedContent, timestamp);
  const payload: ChatMessagePayload = {
    v: 1,
    b: '',
    p: inner.pubkeyHex,
    ts: timestamp,
    sig: inner.signature,
    w: wrappedContent,
    room: { name: options.roomName, code: options.accessCode },
  };

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, context.forumPubkeyHex);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 21423, created_at: timestamp, content: encrypted, tags: [['t', chatTag]] },
    outerSecret,
  );
  await publishToRelaysBestEffort(event, context.relays);
  return { event, chatTag };
}

export async function listRoomAnnouncements(options: {
  forumInput: string;
  relays?: string[];
  salt?: string;
}) {
  const messages = await listGeneralChatMessages(options);
  return messages.flatMap((message) => {
    if (!isRoomAnnouncementValue(message.payload.room)) {
      return [];
    }

    return [{
      eventId: message.eventId,
      payload: message.payload,
      roomName: message.payload.room.name,
      accessCode: message.payload.room.code,
    }];
  });
}

export async function publishRoomChatMessage(options: {
  forumInput: string;
  roomName: string;
  accessCode: string;
  message: string;
  secret?: string;
  signer?: CliSigner;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const timestamp = Math.floor(Date.now() / 1000);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const { pubkey: roomPubkey } = deriveRoomKeypair(context.forumPrivkey, options.roomName, options.accessCode);
  const wrappedContent = wrapContentForSigning(options.message);
  const inner = await signWrappedContent(author, wrappedContent, timestamp);
  const payload: ChatMessagePayload = {
    v: 1,
    b: options.message,
    p: inner.pubkeyHex,
    ts: timestamp,
    sig: inner.signature,
    w: wrappedContent,
    room: options.roomName,
  };

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, roomPubkey);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 21423, created_at: timestamp, content: encrypted, tags: [['t', chatTag]] },
    outerSecret,
  );
  await publishToRelaysBestEffort(event, context.relays);
  return { event, chatTag, roomName: options.roomName };
}

export async function listRoomChatMessages(options: {
  forumInput: string;
  roomName: string;
  accessCode: string;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const { privkey: roomPrivkey } = deriveRoomKeypair(context.forumPrivkey, options.roomName, options.accessCode);
  const events = await fetchEvents({ kinds: [21423], '#t': [chatTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(roomPrivkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ChatMessagePayload;
        if (
          payload.v !== 1
          || typeof payload.b !== 'string'
          || !payload.p
          || payload.room !== options.roomName
          || !payload.sig
          || !payload.w
        ) {
          return null;
        }
        if (!verifyInnerSignature(payload.p, payload.sig, payload.w, payload.ts)) {
          return null;
        }
        return {
          eventId: event.id,
          payload,
          channel: 'room' as const,
          roomName: options.roomName,
        };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}

export async function publishGeneralChatMessage(options: {
  forumInput: string;
  message: string;
  secret?: string;
  signer?: CliSigner;
  sessionSecret?: string;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const sessionMaterial = options.sessionSecret ? describeSecret(options.sessionSecret) : await getForumSessionMaterial();
  const timestamp = Math.floor(Date.now() / 1000);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const wrappedContent = wrapContentForSigning(options.message);
  const inner = await signWrappedContent(author, wrappedContent, timestamp);
  const payload: ChatMessagePayload = {
    v: 1,
    b: options.message,
    p: inner.pubkeyHex,
    sp: sessionMaterial.pubkeyHex,
    ts: timestamp,
    sig: inner.signature,
    w: wrappedContent,
  };

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, context.forumPubkeyHex);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 21423, created_at: timestamp, content: encrypted, tags: [['t', chatTag]] },
    outerSecret,
  );
  await publishToRelaysBestEffort(event, context.relays);
  return { event, chatTag };
}

export async function publishPrivateChatMessage(options: {
  forumInput: string;
  recipientSessionPubkey: string;
  message: string;
  secret?: string;
  signer?: CliSigner;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const timestamp = Math.floor(Date.now() / 1000);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const wrappedContent = wrapContentForSigning(options.message);
  const inner = await signWrappedContent(author, wrappedContent, timestamp);
  const payload: ChatMessagePayload = {
    v: 1,
    b: options.message,
    p: inner.pubkeyHex,
    ts: timestamp,
    sig: inner.signature,
    w: wrappedContent,
  };

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, options.recipientSessionPubkey);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 21423, created_at: timestamp, content: encrypted, tags: [['t', chatTag]] },
    outerSecret,
  );
  await publishToRelaysBestEffort(event, context.relays);
  return { event, chatTag, recipientSessionPubkey: options.recipientSessionPubkey };
}

export async function publishVoiceSignal(options: {
  forumInput: string;
  type: VoiceSignalType;
  channel: 'general' | 'room' | 'private';
  secret?: string;
  signer?: CliSigner;
  sessionSecret?: string;
  roomName?: string;
  accessCode?: string;
  peerPubkey?: string;
  recipientSessionPubkey?: string;
  target?: string;
  sdp?: string;
  candidate?: string;
  muted?: boolean;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const author = await resolveForumAuthor(context, options.secret, options.signer);
  const sessionMaterial = options.sessionSecret ? describeSecret(options.sessionSecret) : await getForumSessionMaterial();
  const timestamp = Math.floor(Date.now() / 1000);
  const chatTag = deriveChatTag(context.forumPrivkey);
  if (options.channel === 'room' && (!options.roomName || !options.accessCode)) {
    throw new Error('Room voice signals require both roomName and accessCode.');
  }
  if (options.channel === 'private' && !options.recipientSessionPubkey) {
    throw new Error('Private voice signals require recipientSessionPubkey.');
  }
  const channelKey = deriveVoiceChannel(options.channel, options.roomName, options.peerPubkey);
  const recipientPubkey = options.channel === 'general'
    ? context.forumPubkeyHex
    : options.channel === 'room'
      ? deriveRoomKeypair(context.forumPrivkey, options.roomName as string, options.accessCode as string).pubkey
      : options.recipientSessionPubkey;

  if (!recipientPubkey) {
    throw new Error('Private voice signals require the recipient session pubkey.');
  }

  const payload: VoiceSignalPayload = {
    v: 1,
    voice: true,
    type: options.type,
    p: sessionMaterial.pubkeyHex,
    ap: author.pubkeyHex,
    ch: channelKey,
    ts: timestamp,
    ...(options.target ? { target: options.target } : {}),
    ...(options.sdp ? { sdp: options.sdp } : {}),
    ...(options.candidate ? { candidate: options.candidate } : {}),
    ...(options.muted !== undefined ? { muted: options.muted } : {}),
  };

  if (payload.type === 'join') {
    const wrappedContent = wrapContentForSigning(`voice-join:${payload.p}`);
    const inner = await signWrappedContent(author, wrappedContent, timestamp);
    payload.sig = inner.signature;
    payload.w = wrappedContent;
  }

  const outerSecret = generateSecretKey();
  const conversationKey = getConversationKey(outerSecret, recipientPubkey);
  const encrypted = nip44Encrypt(JSON.stringify(payload), conversationKey);
  const event = finalizeEvent(
    { kind: 21423, created_at: timestamp, content: encrypted, tags: [['t', chatTag]] },
    outerSecret,
  );
  await publishToRelaysBestEffort(event, context.relays);
  return { event, chatTag, payload };
}

export async function listVoiceSignals(options: {
  forumInput: string;
  channel: 'general' | 'room' | 'private';
  roomName?: string;
  accessCode?: string;
  sessionSecret?: string;
  peerPubkey?: string;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const chatTag = deriveChatTag(context.forumPrivkey);
  if (options.channel === 'room' && (!options.roomName || !options.accessCode)) {
    throw new Error('Room voice listings require both roomName and accessCode.');
  }
  const events = await fetchEvents({ kinds: [21423], '#t': [chatTag] }, context.relays);
  const sessionMaterial = options.channel === 'private'
    ? (options.sessionSecret ? describeSecret(options.sessionSecret) : await getForumSessionMaterial())
    : null;
  const roomPrivkey = options.channel === 'room'
    ? deriveRoomKeypair(context.forumPrivkey, options.roomName as string, options.accessCode as string).privkey
    : null;
  const expectedChannel = options.channel === 'private' && !options.peerPubkey
    ? null
    : deriveVoiceChannel(options.channel, options.roomName, options.peerPubkey);

  const signals = events
    .map((event) => {
      try {
        const conversationKey = options.channel === 'general'
          ? getConversationKey(context.forumPrivkey, event.pubkey)
          : options.channel === 'room'
            ? getConversationKey(roomPrivkey as Uint8Array, event.pubkey)
            : getConversationKey((sessionMaterial as SecretMaterial).secretKey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted);
        if (!isVoiceSignalPayload(payload)) {
          return null;
        }
        if (expectedChannel && payload.ch !== expectedChannel) {
          return null;
        }
        if (options.peerPubkey && payload.ap !== options.peerPubkey) {
          return null;
        }
        return {
          eventId: event.id,
          payload,
          channel: options.channel,
          roomName: options.channel === 'room' ? options.roomName : undefined,
          peerPubkey: options.channel === 'private' ? (payload.ap ?? payload.p) : undefined,
          joinSignatureValid: verifyJoinSignal(payload),
        } as DecryptedVoiceSignal;
      } catch {
        return null;
      }
    });
  return signals
    .filter((entry): entry is DecryptedVoiceSignal => entry !== null)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}

export async function listPrivateChatMessages(options: {
  forumInput: string;
  sessionSecret?: string;
  relays?: string[];
  salt?: string;
  peerPubkey?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const sessionMaterial = options.sessionSecret ? describeSecret(options.sessionSecret) : await getForumSessionMaterial();
  const sessionPrivkey = sessionMaterial.secretKey;
  const events = await fetchEvents({ kinds: [21423], '#t': [chatTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(sessionPrivkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ChatMessagePayload;
        if (payload.v !== 1 || typeof payload.b !== 'string' || !payload.p || !payload.sig || !payload.w) {
          return null;
        }
        if (!verifyInnerSignature(payload.p, payload.sig, payload.w, payload.ts)) {
          return null;
        }
        if (options.peerPubkey && payload.p !== options.peerPubkey) {
          return null;
        }
        return {
          eventId: event.id,
          payload,
          channel: 'private' as const,
          peerPubkey: payload.p,
        };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}

export async function listGeneralChatMessages(options: {
  forumInput: string;
  relays?: string[];
  salt?: string;
}) {
  const context = createContext(options.forumInput, options.relays, options.salt);
  const chatTag = deriveChatTag(context.forumPrivkey);
  const events = await fetchEvents({ kinds: [21423], '#t': [chatTag] }, context.relays);
  return events
    .map((event) => {
      try {
        const conversationKey = getConversationKey(context.forumPrivkey, event.pubkey);
        const decrypted = nip44Decrypt(event.content, conversationKey);
        const payload = JSON.parse(decrypted) as ChatMessagePayload;
        if (payload.v !== 1 || typeof payload.b !== 'string' || !payload.p || !payload.sig || !payload.w) {
          return null;
        }
        if (!verifyInnerSignature(payload.p, payload.sig, payload.w, payload.ts)) {
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
    .filter((entry) => entry !== null)
    .sort((left, right) => right.payload.ts - left.payload.ts);
}
