import { base64urlToBytes, base64urlToHex, bytesToBase64url } from '@nowhere/codec';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';

export interface SiteSignatureCheck {
  unsignedFragment: string;
  signed: boolean;
  signerPubkeyHex: string | null;
}

export function verifySiteSignature(
  fragment: string,
  pubkeyBase64url: string,
): SiteSignatureCheck {
  try {
    const fullBytes = base64urlToBytes(fragment);
    if (fullBytes.length <= 64) {
      return { unsignedFragment: fragment, signed: false, signerPubkeyHex: null };
    }

    const dataBytes = fullBytes.slice(0, fullBytes.length - 64);
    const sigBytes = fullBytes.slice(fullBytes.length - 64);
    const unsignedFragment = bytesToBase64url(dataBytes);
    const sigHex = Array.from(sigBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const pubkeyHex = base64urlToHex(pubkeyBase64url);

    const event = {
      kind: 22242,
      created_at: 0,
      tags: [] as string[][],
      content: unsignedFragment,
      pubkey: pubkeyHex,
      id: '',
      sig: sigHex,
    };
    event.id = getEventHash(event);

    if (!verifyEvent(event)) {
      return { unsignedFragment: fragment, signed: false, signerPubkeyHex: null };
    }

    return { unsignedFragment, signed: true, signerPubkeyHex: pubkeyHex };
  } catch {
    return { unsignedFragment: fragment, signed: false, signerPubkeyHex: null };
  }
}
