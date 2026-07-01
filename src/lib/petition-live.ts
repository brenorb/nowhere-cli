import { createHash } from 'node:crypto';
import { nip44 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { parseSecretKeyInput } from './keys.js';

export const NOWHERE_DTAG_PREFIX = 'nowhr';
export const PETITION_SIGNATURE_KIND = 30078;
export const POW_DIFFICULTY = 20;

export type SigningPhase = 'encrypting' | 'pow' | 'publishing';

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
}

export interface PetitionRelayTransport {
  publish(event: Event, relays: string[]): Promise<void>;
  fetch(filter: Filter, relays: string[]): Promise<Event[]>;
  count?(filter: Filter, relays: string[]): Promise<number>;
}

export interface PetitionSignaturePayload extends Record<string, unknown> {}

export interface PublishPetitionSignatureOptions<TPayload extends PetitionSignaturePayload> {
  payload: TPayload;
  creatorPubkeyHex: string;
  fragment: string;
  relays: string[];
  secret?: string;
  transport?: PetitionRelayTransport;
  timestamp?: number;
  powDifficulty?: number;
  onPhase?: (phase: SigningPhase) => void;
}

export interface PublishedPetitionSignature {
  anonymous: boolean;
  petitionHash: string;
  dTag: string;
  signerPubkeyHex: string;
  powDifficulty: number;
  event: Event;
}

export interface CountPetitionSignaturesOptions {
  fragment: string;
  relays: string[];
  transport?: PetitionRelayTransport;
}

export interface CountPetitionSignaturesResult {
  petitionHash: string;
  dTag: string;
  count: number;
}

export interface FetchPetitionSignaturesOptions {
  fragment: string;
  ownerSecret: string;
  relays: string[];
  transport?: PetitionRelayTransport;
  powDifficulty?: number;
}

export interface DecryptedPetitionSignature<TPayload extends PetitionSignaturePayload = PetitionSignaturePayload> {
  pubkey: string;
  createdAt: number;
  event: Event;
  payload: TPayload | null;
  decryptError: string | null;
}

export interface FetchPetitionSignaturesResult<TPayload extends PetitionSignaturePayload = PetitionSignaturePayload> {
  petitionHash: string;
  dTag: string;
  rawEventCount: number;
  dedupedEventCount: number;
  rejectedPowCount: number;
  signatures: DecryptedPetitionSignature<TPayload>[];
}

export function countLeadingZeroBits(hex: string): number {
  let count = 0;
  for (const ch of hex) {
    const nibble = Number.parseInt(ch, 16);
    if (nibble === 0) {
      count += 4;
      continue;
    }

    if (nibble < 2) count += 3;
    else if (nibble < 4) count += 2;
    else if (nibble < 8) count += 1;
    break;
  }
  return count;
}

export async function applyPoW(
  event: UnsignedEvent,
  difficulty: number,
  onProgress?: (nonce: number) => void,
): Promise<UnsignedEvent & { id: string }> {
  const baseTags = event.tags.filter((tag) => tag[0] !== 'nonce');
  let nonce = 0;
  const batchSize = 2000;

  while (true) {
    for (let index = 0; index < batchSize; index += 1) {
      const candidate = {
        ...event,
        tags: [...baseTags, ['nonce', String(nonce), String(difficulty)]],
      };
      const id = getEventHash(candidate);
      if (countLeadingZeroBits(id) >= difficulty) {
        return { ...candidate, id };
      }
      nonce += 1;
    }

    onProgress?.(nonce);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function computePetitionHash(fragment: string): Promise<string> {
  return createHash('sha256').update(fragment).digest('hex').slice(0, 16);
}

export function petitionDTag(petitionHash: string): string {
  return `${NOWHERE_DTAG_PREFIX}/${petitionHash}`;
}

export async function petitionDTagFromFragment(fragment: string): Promise<string> {
  return petitionDTag(await computePetitionHash(fragment));
}

export function createSimplePoolPetitionTransport(pool = new SimplePool()): PetitionRelayTransport {
  return {
    async publish(event, relays) {
      const uniqueRelays = normalizeRelays(relays);
      const results = await Promise.allSettled(pool.publish(uniqueRelays, event));
      const confirmed = results.filter(
        (result) =>
          result.status === 'fulfilled' && !String(result.value).startsWith('connection failure'),
      );

      if (confirmed.length > 0) {
        return;
      }

      const reasons = results.map((result) =>
        result.status === 'rejected' ? String(result.reason) : String(result.value),
      );
      throw new Error(`Failed to publish to any relay: ${reasons.join('; ')}`);
    },

    async fetch(filter, relays) {
      return pool.querySync(normalizeRelays(relays), filter);
    },

    async count(filter, relays) {
      const uniqueRelays = normalizeRelays(relays);
      const countWithTimeout = (url: string): Promise<number> =>
        Promise.race([
          (async () => {
            const relay = await pool.ensureRelay(url);
            return relay.count([filter], {});
          })(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('COUNT timeout')), 4000);
          }),
        ]);

      const counts = await Promise.allSettled(uniqueRelays.map((url) => countWithTimeout(url)));

      let anySucceeded = false;
      let max = 0;
      for (const result of counts) {
        if (result.status === 'fulfilled') {
          anySucceeded = true;
          if (result.value > max) {
            max = result.value;
          }
        }
      }

      if (anySucceeded) {
        return max;
      }

      const events = await pool.querySync(uniqueRelays, filter);
      return events.length;
    },
  };
}

export async function publishPetitionSignature<TPayload extends PetitionSignaturePayload>(
  options: PublishPetitionSignatureOptions<TPayload>,
): Promise<PublishedPetitionSignature> {
  const transport = options.transport ?? getDefaultTransport();
  const petitionHash = await computePetitionHash(options.fragment);
  const dTag = petitionDTag(petitionHash);
  const secretKey = options.secret ? parseSecretKeyInput(options.secret) : generateSecretKey();
  const signerPubkeyHex = getPublicKey(secretKey);
  const content = nip44.encrypt(
    JSON.stringify(options.payload),
    nip44.getConversationKey(secretKey, options.creatorPubkeyHex),
  );
  const powDifficulty = options.powDifficulty ?? POW_DIFFICULTY;

  options.onPhase?.('encrypting');

  const unsigned: UnsignedEvent = {
    kind: PETITION_SIGNATURE_KIND,
    created_at: Math.floor((options.timestamp ?? Date.now()) / 1000),
    content,
    tags: [['d', dTag]],
    pubkey: signerPubkeyHex,
  };

  options.onPhase?.('pow');
  const withPow = await applyPoW(unsigned, powDifficulty);
  const event = finalizeEvent(
    {
      kind: withPow.kind,
      created_at: withPow.created_at,
      content: withPow.content,
      tags: withPow.tags,
    },
    secretKey,
  );

  if (!verifyEvent(event)) {
    throw new Error('Failed to verify signed petition signature event.');
  }

  options.onPhase?.('publishing');
  await transport.publish(event, options.relays);

  return {
    anonymous: !options.secret,
    petitionHash,
    dTag,
    signerPubkeyHex,
    powDifficulty,
    event,
  };
}

export async function countPetitionSignatures(
  options: CountPetitionSignaturesOptions,
): Promise<CountPetitionSignaturesResult> {
  const transport = options.transport ?? getDefaultTransport();
  const petitionHash = await computePetitionHash(options.fragment);
  const dTag = petitionDTag(petitionHash);
  const filter = buildPetitionFilter(dTag);

  const count = transport.count
    ? await transport.count(filter, options.relays)
    : (await transport.fetch(filter, options.relays)).length;

  return { petitionHash, dTag, count };
}

export async function fetchPetitionSignaturesForOwner<TPayload extends PetitionSignaturePayload = PetitionSignaturePayload>(
  options: FetchPetitionSignaturesOptions,
): Promise<FetchPetitionSignaturesResult<TPayload>> {
  const transport = options.transport ?? getDefaultTransport();
  const petitionHash = await computePetitionHash(options.fragment);
  const dTag = petitionDTag(petitionHash);
  const ownerSecretKey = parseSecretKeyInput(options.ownerSecret);
  const powDifficulty = options.powDifficulty ?? POW_DIFFICULTY;
  const rawEvents = await transport.fetch(buildPetitionFilter(dTag), options.relays);

  const dedupedByPubkey = new Map<string, Event>();
  for (const event of rawEvents) {
    const existing = dedupedByPubkey.get(event.pubkey);
    if (!existing || event.created_at > existing.created_at) {
      dedupedByPubkey.set(event.pubkey, event);
    }
  }

  const dedupedEvents = [...dedupedByPubkey.values()];
  const acceptedEvents = dedupedEvents.filter((event) => {
    const id = event.id ?? getEventHash(event);
    return countLeadingZeroBits(id) >= powDifficulty;
  });
  const rejectedPowCount = dedupedEvents.length - acceptedEvents.length;
  const sortedEvents = acceptedEvents.sort((left, right) => right.created_at - left.created_at);

  const signatures = sortedEvents.map<DecryptedPetitionSignature<TPayload>>((event) => {
    try {
      const plaintext = nip44.decrypt(
        event.content,
        nip44.getConversationKey(ownerSecretKey, event.pubkey),
      );
      return {
        pubkey: event.pubkey,
        createdAt: event.created_at,
        event,
        payload: JSON.parse(plaintext) as TPayload,
        decryptError: null,
      };
    } catch (error) {
      return {
        pubkey: event.pubkey,
        createdAt: event.created_at,
        event,
        payload: null,
        decryptError: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return {
    petitionHash,
    dTag,
    rawEventCount: rawEvents.length,
    dedupedEventCount: dedupedEvents.length,
    rejectedPowCount,
    signatures,
  };
}

function normalizeRelays(relays: string[]): string[] {
  return [...new Set(relays.map((relay) => relay.trim()).filter(Boolean))];
}

function buildPetitionFilter(dTag: string): Filter {
  return {
    kinds: [PETITION_SIGNATURE_KIND],
    '#d': [dTag],
  };
}

let defaultTransport: PetitionRelayTransport | null = null;

function getDefaultTransport(): PetitionRelayTransport {
  if (!defaultTransport) {
    defaultTransport = createSimplePoolPetitionTransport();
  }
  return defaultTransport;
}
