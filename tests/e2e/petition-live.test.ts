import { encodePetition, type PetitionData } from '@nowhere/codec';
import { describe, expect, test } from 'vitest';
import { matchFilter } from 'nostr-tools';
import { nip44 } from 'nostr-tools';
import type { Event } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import {
  PETITION_SIGNATURE_KIND,
  POW_DIFFICULTY,
  type PetitionRelayTransport,
  type PetitionSignaturePayload,
  computePetitionHash,
  countLeadingZeroBits,
  countPetitionSignatures,
  fetchPetitionSignaturesForOwner,
  petitionDTag,
  publishPetitionSignature,
  validatePetitionSignaturePayload,
} from '../../src/lib/petition-live.js';

class MemoryPetitionTransport implements PetitionRelayTransport {
  readonly events: Event[] = [];

  async publish(event: Event): Promise<void> {
    this.events.push(event);
  }

  async fetch(filter: Filter): Promise<Event[]> {
    return this.events.filter((event) => matchFilter(filter, event));
  }

  async count(filter: Filter): Promise<number> {
    return this.events.filter((event) => matchFilter(filter, event)).length;
  }
}

function samplePetition(ownerNowherePubkey: string): PetitionData {
  return {
    version: 1,
    siteType: 'petition',
    pubkey: ownerNowherePubkey,
    name: 'Keep the Channel Open',
    description: 'A petition to keep communications open.',
    tags: [{ key: 'N', value: undefined }, { key: 'R', value: undefined }],
  };
}

async function makeInvalidPowEvent(options: {
  payload: PetitionSignaturePayload;
  signerSecretHex: string;
  creatorPubkeyHex: string;
  dTag: string;
  createdAt: number;
}): Promise<Event> {
  const signerSecret = Buffer.from(options.signerSecretHex, 'hex');
  const content = nip44.encrypt(
    JSON.stringify(options.payload),
    nip44.getConversationKey(signerSecret, options.creatorPubkeyHex),
  );

  let createdAt = options.createdAt;
  while (true) {
    const event = finalizeEvent(
      {
        kind: PETITION_SIGNATURE_KIND,
        created_at: createdAt,
        content,
        tags: [['d', options.dTag]],
      },
      signerSecret,
    );

    if (countLeadingZeroBits(event.id) < POW_DIFFICULTY) {
      return event;
    }

    createdAt += 1;
  }
}

describe('petition live runtime', () => {
  test('validates petition-required fields and country restrictions from petition tags', async () => {
    const petition = samplePetition(generateSecretMaterial().nowherePubkey);
    petition.tags = [
      { key: 'N', value: undefined },
      { key: 'E', value: undefined },
      { key: 'c', value: 'BR.US' },
    ];

    expect(() => validatePetitionSignaturePayload({ email: 'signer@example.com', country: 'BR' }, petition.tags))
      .toThrow(/name/i);
    expect(() => validatePetitionSignaturePayload({ name: 'Signer', email: 'signer@example.com', country: 'CA' }, petition.tags))
      .toThrow(/country/i);

    expect(() => validatePetitionSignaturePayload({
      name: 'Signer',
      email: 'signer@example.com',
      country: 'US',
    }, petition.tags)).not.toThrow();
  });

  test('publishes anonymous and secret-backed signatures with upstream kind, d-tag, and PoW', async () => {
    const transport = new MemoryPetitionTransport();
    const owner = generateSecretMaterial();
    const signer = generateSecretMaterial();
    const fragment = encodePetition(samplePetition(owner.nowherePubkey)).fragment;
    const expectedHash = await computePetitionHash(fragment);
    const expectedDTag = petitionDTag(expectedHash);

    const anonymousResult = await publishPetitionSignature({
      payload: { name: 'Anonymous', comment: 'Signed without a long-term key.' },
      creatorPubkeyHex: owner.pubkeyHex,
      fragment,
      relays: ['wss://relay.example.test'],
      transport,
      timestamp: 1_719_000_000_000,
    });

    const secretResult = await publishPetitionSignature({
      payload: { name: 'Named Signer', email: 'signer@example.com', ts: 1_719_000_123_000 },
      creatorPubkeyHex: owner.pubkeyHex,
      fragment,
      relays: ['wss://relay.example.test'],
      transport,
      secret: signer.secretHex,
      timestamp: 1_719_000_123_000,
    });

    expect(transport.events).toHaveLength(2);
    expect(anonymousResult.anonymous).toBe(true);
    expect(secretResult.anonymous).toBe(false);
    expect(secretResult.signerPubkeyHex).toBe(signer.pubkeyHex);
    expect(anonymousResult.dTag).toBe(expectedDTag);
    expect(secretResult.dTag).toBe(expectedDTag);

    for (const event of transport.events) {
      expect(event.kind).toBe(PETITION_SIGNATURE_KIND);
      expect(event.tags).toContainEqual(['d', expectedDTag]);
      expect(event.tags.some((tag) => tag[0] === 'nonce' && tag[2] === String(POW_DIFFICULTY))).toBe(true);
      expect(countLeadingZeroBits(event.id)).toBeGreaterThanOrEqual(POW_DIFFICULTY);
    }
  }, 30_000);

  test('counts by petition d-tag and decrypts owner-visible signatures while rejecting insufficient PoW', async () => {
    const transport = new MemoryPetitionTransport();
    const owner = generateSecretMaterial();
    const signer = generateSecretMaterial();
    const rejectedSigner = generateSecretMaterial();
    const fragment = encodePetition(samplePetition(owner.nowherePubkey)).fragment;

    const anonymousPublish = await publishPetitionSignature({
      payload: { name: 'Anonymous', country: 'BR' },
      creatorPubkeyHex: owner.pubkeyHex,
      fragment,
      relays: ['wss://relay.example.test'],
      transport,
      timestamp: 1_719_000_000_000,
    });

    const secretPublish = await publishPetitionSignature({
      payload: { name: 'Named Signer', email: 'signer@example.com', comment: 'Count me in.' },
      creatorPubkeyHex: owner.pubkeyHex,
      fragment,
      relays: ['wss://relay.example.test'],
      transport,
      secret: signer.secretHex,
      timestamp: 1_719_000_005_000,
    });

    const invalidPowEvent = await makeInvalidPowEvent({
      payload: { name: 'Rejected Signer' },
      signerSecretHex: rejectedSigner.secretHex,
      creatorPubkeyHex: owner.pubkeyHex,
      dTag: anonymousPublish.dTag,
      createdAt: 1_719_000_010,
    });
    transport.events.push(invalidPowEvent);

    const countResult = await countPetitionSignatures({
      fragment,
      relays: ['wss://relay.example.test'],
      transport,
    });

    expect(countResult.dTag).toBe(anonymousPublish.dTag);
    expect(countResult.count).toBe(3);

    const fetched = await fetchPetitionSignaturesForOwner<{
      name: string;
      email?: string;
      comment?: string;
      country?: string;
    }>({
      fragment,
      ownerSecret: owner.secretHex,
      relays: ['wss://relay.example.test'],
      transport,
    });

    expect(fetched.dTag).toBe(anonymousPublish.dTag);
    expect(fetched.rawEventCount).toBe(3);
    expect(fetched.dedupedEventCount).toBe(3);
    expect(fetched.rejectedPowCount).toBe(1);
    expect(fetched.signatures).toHaveLength(2);
    expect(fetched.signatures.every((entry) => entry.decryptError === null)).toBe(true);

    const byPubkey = new Map(fetched.signatures.map((entry) => [entry.pubkey, entry]));
    expect(byPubkey.get(anonymousPublish.signerPubkeyHex)?.payload?.name).toBe('Anonymous');
    expect(byPubkey.get(secretPublish.signerPubkeyHex)?.payload?.email).toBe('signer@example.com');
    expect(byPubkey.get(secretPublish.signerPubkeyHex)?.payload?.comment).toBe('Count me in.');
    expect(byPubkey.has(getPublicKey(Buffer.from(rejectedSigner.secretHex, 'hex')))).toBe(false);
  }, 30_000);
});
