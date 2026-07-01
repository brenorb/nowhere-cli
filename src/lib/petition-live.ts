import { createHash } from 'node:crypto';
import type { Tag } from '@nowhere/codec';
import { nip44 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import type { CliSigner } from './active-signer.js';
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

export type PetitionSignaturePayload = Record<string, unknown>;

export interface PublishPetitionSignatureOptions<TPayload extends PetitionSignaturePayload> {
  payload: TPayload;
  creatorPubkeyHex: string;
  fragment: string;
  relays: string[];
  petitionTags?: Tag[];
  secret?: string;
  signer?: CliSigner;
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
  ownerSecret?: string;
  ownerSigner?: CliSigner;
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

export type PetitionFieldState = 'off' | 'optional' | 'required';

function hasTag(tags: Tag[], key: string): boolean {
  return tags.some((tag) => tag.key === key);
}

function getFieldState(tags: Tag[], lower: string, upper: string): PetitionFieldState {
  if (hasTag(tags, upper)) {
    return 'required';
  }
  if (hasTag(tags, lower)) {
    return 'optional';
  }
  return 'off';
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validatePetitionSignaturePayload(payload: PetitionSignaturePayload, tags: Tag[]): void {
  const fieldChecks: Array<{ state: PetitionFieldState; key: string; label: string }> = [
    { state: getFieldState(tags, 'n', 'N'), key: 'name', label: 'Name' },
    { state: getFieldState(tags, 'e', 'E'), key: 'email', label: 'Email' },
    { state: getFieldState(tags, 'a', 'A'), key: 'address', label: 'Location' },
    { state: getFieldState(tags, 'p', 'P'), key: 'phone', label: 'Phone' },
    { state: getFieldState(tags, 'z', 'Z'), key: 'npub', label: 'Nostr npub' },
    { state: getFieldState(tags, 'u', 'U'), key: 'org', label: 'Organisation' },
  ];

  for (const fieldCheck of fieldChecks) {
    if (fieldCheck.state === 'required' && !hasNonEmptyString(payload[fieldCheck.key])) {
      throw new Error(`${fieldCheck.label} is required by this petition.`);
    }
  }

  const fullAddressState = getFieldState(tags, 'b', 'B');
  if (
    fullAddressState === 'required'
    && (!hasNonEmptyString(payload.street) || !hasNonEmptyString(payload.city) || !hasNonEmptyString(payload.addrCountry))
  ) {
    throw new Error('Street, city, and address country are required by this petition.');
  }

  const allowedCountries = tags.find((tag) => tag.key === 'c')?.value?.split('.').filter(Boolean) ?? [];
  if (allowedCountries.length > 0) {
    if (!hasNonEmptyString(payload.country)) {
      throw new Error('Country is required by this petition.');
    }
    if (!allowedCountries.includes(payload.country)) {
      throw new Error(`Country must be one of: ${allowedCountries.join(', ')}.`);
    }
  }
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

async function fetchPetitionEventsPaginated(
  transport: PetitionRelayTransport,
  dTag: string,
  relays: string[],
): Promise<Event[]> {
  const pageLimit = 5000;
  const seen = new Set<string>();
  const events: Event[] = [];
  let until: number | undefined;

  while (true) {
    const batch = await transport.fetch(
      {
        ...buildPetitionFilter(dTag),
        limit: pageLimit,
        ...(until !== undefined ? { until } : {}),
      },
      relays,
    );
    if (batch.length === 0) {
      break;
    }

    const fresh = batch.filter((event) => !seen.has(event.id));
    for (const event of fresh) {
      seen.add(event.id);
      events.push(event);
    }

    const oldest = batch.reduce((min, event) => Math.min(min, event.created_at), Number.POSITIVE_INFINITY);
    const nextUntil = oldest - 1;
    if (until !== undefined && nextUntil >= until) {
      break;
    }
    until = nextUntil;
  }

  return events;
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
  if (options.petitionTags) {
    validatePetitionSignaturePayload(options.payload, options.petitionTags);
  }

  const transport = options.transport ?? getDefaultTransport();
  const petitionHash = await computePetitionHash(options.fragment);
  const dTag = petitionDTag(petitionHash);
  const localSecretKey = options.signer
    ? undefined
    : options.secret
      ? parseSecretKeyInput(options.secret)
      : generateSecretKey();
  const signerPubkeyHex = options.signer
    ? await options.signer.getPublicKey()
    : getPublicKey(localSecretKey as Uint8Array);
  const content = options.signer
    ? await options.signer.nip44Encrypt(options.creatorPubkeyHex, JSON.stringify(options.payload))
    : nip44.encrypt(
      JSON.stringify(options.payload),
      nip44.getConversationKey(localSecretKey as Uint8Array, options.creatorPubkeyHex),
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
  const event = options.signer
    ? await options.signer.signEvent({
      kind: withPow.kind,
      created_at: withPow.created_at,
      content: withPow.content,
      tags: withPow.tags,
    })
    : finalizeEvent(
      {
        kind: withPow.kind,
        created_at: withPow.created_at,
        content: withPow.content,
        tags: withPow.tags,
      },
      localSecretKey as Uint8Array,
    );

  if (!verifyEvent(event)) {
    throw new Error('Failed to verify signed petition signature event.');
  }

  options.onPhase?.('publishing');
  await transport.publish(event, options.relays);

  return {
    anonymous: !options.secret && !options.signer,
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
  if (!options.ownerSecret && !options.ownerSigner) {
    throw new Error('Pass either an owner secret or an active signer to decrypt petition signatures.');
  }
  const ownerSecretKey = options.ownerSecret ? parseSecretKeyInput(options.ownerSecret) : null;
  const powDifficulty = options.powDifficulty ?? POW_DIFFICULTY;
  const rawEvents = await fetchPetitionEventsPaginated(transport, dTag, options.relays);

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
      if (options.ownerSigner) {
        return {
          pubkey: event.pubkey,
          createdAt: event.created_at,
          event,
          payload: null,
          decryptError: '__async__',
        };
      }

      const plaintext = nip44.decrypt(
        event.content,
        nip44.getConversationKey(ownerSecretKey as Uint8Array, event.pubkey),
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

  if (options.ownerSigner) {
    for (let index = 0; index < signatures.length; index += 1) {
      const entry = signatures[index];
      if (!entry || entry.decryptError !== '__async__') {
        continue;
      }

      try {
        const plaintext = await options.ownerSigner.nip44Decrypt(entry.event.pubkey, entry.event.content);
        signatures[index] = {
          ...entry,
          payload: JSON.parse(plaintext) as TPayload,
          decryptError: null,
        };
      } catch (error) {
        signatures[index] = {
          ...entry,
          payload: null,
          decryptError: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

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
