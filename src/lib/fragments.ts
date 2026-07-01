import {
  base64urlToHex,
  bytesToBase64url,
  computeAllVerificationPhrases,
  computeFingerprint,
  computeFingerprintFromString,
  computeSellerFingerprint,
  computeVerificationPhrase,
  decode,
  decryptFragment,
  serializeArt,
  serializeDrop,
  serializeEvent,
  serializeForum,
  serializeFundraiser,
  serializeMessage,
  serializePetition,
  serialize as serializeStore,
  type ArtData,
  type DropData,
  type EventData,
  type ForumData,
  type FundraiserData,
  type MessageData,
  type PetitionData,
  type SiteData,
  type Tag,
} from '@nowhere/codec';
import { DEFAULT_RENDERER_ORIGIN } from './constants.js';
import { verifySiteSignature } from './site-signature.js';

export interface ResolvedSite {
  originalInput: string;
  inputKind: 'url' | 'fragment';
  normalizedFragment: string;
  decodedFragment: string | null;
  unsignedFragment: string | null;
  decrypted: boolean;
  signed: boolean;
  signaturePubkeyHex: string | null;
  siteData: SiteData | null;
  decodeError: string | null;
}

export interface VerificationSummary {
  phraseLength: number;
  authorFingerprint: string | null;
  siteFingerprint: string;
  authorPhrase: string | null;
  sitePhrase: string;
  allAuthorPhrases: Record<number, string> | null;
  allSitePhrases: Record<number, string>;
}

export function normalizeToFragment(value: string): {
  fragment: string;
  inputKind: 'url' | 'fragment';
} {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Expected a Nowhere fragment or URL.');
  }

  const hashIndex = trimmed.indexOf('#');
  if (hashIndex >= 0) {
    return {
      fragment: trimmed.slice(hashIndex + 1).trim(),
      inputKind: 'url',
    };
  }

  return {
    fragment: trimmed,
    inputKind: 'fragment',
  };
}

export function fragmentToUrl(fragment: string): string {
  return `${DEFAULT_RENDERER_ORIGIN}/s#${fragment}`;
}

function getPhraseLength(tags: Tag[]): number {
  const tag = tags.find((entry) => entry.key === 'V');
  const parsed = tag?.value ? Number.parseInt(tag.value, 10) : 6;
  if (Number.isNaN(parsed)) {
    return 6;
  }
  return Math.max(3, Math.min(12, parsed));
}

async function computeSiteFingerprint(data: SiteData): Promise<string> {
  switch (data.siteType) {
    case 'store':
      return computeFingerprint(data);
    case 'message':
      return computeFingerprintFromString(serializeMessage(data as MessageData));
    case 'fundraiser':
      return computeFingerprintFromString(serializeFundraiser(data as FundraiserData));
    case 'petition':
      return computeFingerprintFromString(serializePetition(data as PetitionData));
    case 'discussion':
      return computeFingerprintFromString(serializeForum(data as ForumData));
    case 'drop':
      return computeFingerprintFromString(serializeDrop(data as DropData));
    case 'art':
      return computeFingerprintFromString(serializeArt(data as ArtData));
    case 'event':
      return computeFingerprintFromString(serializeEvent(data as EventData));
    default:
      return computeFingerprintFromString(serializeStore(data as never));
  }
}

export async function computeVerificationSummary(
  data: SiteData,
): Promise<VerificationSummary> {
  const phraseLength = getPhraseLength(data.tags);
  const siteFingerprint = await computeSiteFingerprint(data);
  const authorFingerprint = data.pubkey
    ? await computeSellerFingerprint(base64urlToHex(data.pubkey))
    : null;

  return {
    phraseLength,
    authorFingerprint,
    siteFingerprint,
    authorPhrase: authorFingerprint ? computeVerificationPhrase(authorFingerprint, phraseLength) : null,
    sitePhrase: computeVerificationPhrase(siteFingerprint, phraseLength),
    allAuthorPhrases: authorFingerprint ? computeAllVerificationPhrases(authorFingerprint) : null,
    allSitePhrases: computeAllVerificationPhrases(siteFingerprint),
  };
}

export async function resolveSiteInput(
  input: string,
  password?: string,
): Promise<ResolvedSite> {
  const { fragment, inputKind } = normalizeToFragment(input);
  const workingFragment = password ? await decryptFragment(fragment, password) : fragment;
  let decodedFragment: string | null = null;
  let unsignedFragment: string | null = null;
  let signed = false;
  let signaturePubkeyHex: string | null = null;
  let siteData: SiteData | null = null;
  let decodeError: string | null = null;

  try {
    const directData = decode(workingFragment);
    const signature = directData.pubkey
      ? verifySiteSignature(workingFragment, directData.pubkey)
      : { unsignedFragment: workingFragment, signed: false, signerPubkeyHex: null };

    decodedFragment = workingFragment;
    unsignedFragment = signature.unsignedFragment;
    signed = signature.signed;
    signaturePubkeyHex = signature.signerPubkeyHex;
    siteData = directData;
  } catch (directError) {
    try {
      const rawBytes = Buffer.from(workingFragment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (rawBytes.length <= 64) {
        throw directError;
      }

      const candidateUnsigned = bytesToBase64url(rawBytes.subarray(0, rawBytes.length - 64));
      const candidateData = decode(candidateUnsigned);
      const signature = candidateData.pubkey
        ? verifySiteSignature(workingFragment, candidateData.pubkey)
        : { unsignedFragment: candidateUnsigned, signed: false, signerPubkeyHex: null };

      decodedFragment = workingFragment;
      unsignedFragment = signature.signed ? candidateUnsigned : null;
      signed = signature.signed;
      signaturePubkeyHex = signature.signerPubkeyHex;
      siteData = candidateData;
      if (!signature.signed) {
        decodeError = directError instanceof Error ? directError.message : 'Failed to decode fragment.';
      }
    } catch {
      decodeError = directError instanceof Error ? directError.message : 'Failed to decode fragment.';
    }
  }

  return {
    originalInput: input,
    inputKind,
    normalizedFragment: fragment,
    decodedFragment,
    unsignedFragment,
    decrypted: Boolean(password),
    signed,
    signaturePubkeyHex,
    siteData,
    decodeError,
  };
}
