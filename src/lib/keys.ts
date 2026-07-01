import { bytesToBase64url, bytesToHex, hexToBytes } from '@nowhere/codec';
import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

export interface SecretMaterial {
  secretHex: string;
  secretKey: Uint8Array;
  pubkeyHex: string;
  npub: string;
  nsec: string;
  nowherePubkey: string;
}

export function parseSecretKeyInput(value: string): Uint8Array {
  const trimmed = value.trim();
  if (trimmed.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== 'nsec') {
      throw new Error('Expected an nsec secret key.');
    }
    return decoded.data as Uint8Array;
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed.toLowerCase());
  }

  throw new Error('Secret key must be a 64-character hex key or an nsec.');
}

export function describeSecret(secretInput: string): SecretMaterial {
  const secretKey = parseSecretKeyInput(secretInput);
  return describeSecretBytes(secretKey);
}

export function describeSecretBytes(secretKey: Uint8Array): SecretMaterial {
  const secretHex = bytesToHex(secretKey);
  const pubkeyHex = getPublicKey(secretKey);
  return {
    secretHex,
    secretKey,
    pubkeyHex,
    npub: nip19.npubEncode(pubkeyHex),
    nsec: nip19.nsecEncode(secretKey),
    nowherePubkey: bytesToBase64url(hexToBytes(pubkeyHex)),
  };
}

export function generateSecretMaterial(): SecretMaterial {
  return describeSecretBytes(generateSecretKey());
}
