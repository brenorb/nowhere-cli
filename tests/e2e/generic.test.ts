import { bytesToBase64url, encodeMessage, type MessageData } from '@nowhere/codec';
import { describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPublicKey } from 'nostr-tools/pure';
import { generateSecretMaterial } from '../../src/lib/keys.js';

const execFileAsync = promisify(execFile);
const cli = async (...args: string[]) => {
  const result = await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], {
    cwd: '/Users/breno/Documents/code/PROJECTS/HRF_GRANT/nowhere-cli',
  });
  return JSON.parse(result.stdout);
};

function sampleMessage(nowherePubkey: string): MessageData {
  return {
    version: 1,
    siteType: 'message',
    pubkey: nowherePubkey,
    name: 'Alice',
    description: 'Hello from the CLI.',
    tags: [{ key: 't', value: 'Status Update' }],
  };
}

describe('generic CLI commands', () => {
  test('keygen emits the expected Nostr and Nowhere formats', async () => {
    const payload = await cli('keygen', '--json');

    expect(payload.secretHex).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.nsec).toMatch(/^nsec1/);
    expect(payload.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.npub).toMatch(/^npub1/);
    expect(payload.nowherePubkey).toHaveLength(43);
  });

  test('pubkey derives the expected public-key formats from an existing secret', async () => {
    const material = generateSecretMaterial();
    const payload = await cli('pubkey', '--secret', material.nsec, '--json');

    expect(payload.pubkeyHex).toBe(material.pubkeyHex);
    expect(payload.npub).toBe(material.npub);
    expect(payload.nowherePubkey).toBe(material.nowherePubkey);
  });

  test('sign and verify round-trip a Nowhere fragment', async () => {
    const material = generateSecretMaterial();
    const fragment = encodeMessage(sampleMessage(material.nowherePubkey)).fragment;

    const signed = await cli('sign', fragment, '--secret', material.nsec, '--json');
    expect(signed.signedFragment).not.toBe(fragment);

    const verified = await cli('verify', signed.signedFragment, '--json');
    expect(verified.signed).toBe(true);
    expect(verified.signaturePubkeyHex).toBe(material.pubkeyHex);
    expect(verified.unsignedFragment).toBe(fragment);
  });

  test('inspect exposes decoded site data and verification phrases', async () => {
    const material = generateSecretMaterial();
    const fragment = encodeMessage(sampleMessage(material.nowherePubkey)).fragment;
    const inspected = await cli('inspect', fragmentToUrl(fragment), '--json');

    expect(inspected.site.siteType).toBe('message');
    expect(inspected.site.name).toBe('Alice');
    expect(inspected.verification.sitePhrase).toBeTypeOf('string');
    expect(inspected.verification.authorPhrase).toBeTypeOf('string');
  });

  test('encrypt and decrypt round-trip a fragment losslessly', async () => {
    const material = generateSecretMaterial();
    const fragment = encodeMessage(sampleMessage(material.nowherePubkey)).fragment;

    const encrypted = await cli('encrypt', fragment, '--password', 'correct horse battery staple', '--json');
    expect(encrypted.encryptedFragment).not.toBe(fragment);

    const decrypted = await cli('decrypt', encrypted.encryptedFragment, '--password', 'correct horse battery staple', '--json');
    expect(decrypted.fragment).toBe(fragment);
  });

  test('signed fragments keep the embedded public key aligned with the secret key', async () => {
    const material = generateSecretMaterial();
    const fragment = encodeMessage(sampleMessage(material.nowherePubkey)).fragment;
    const signed = await cli('sign', fragment, '--secret', material.secretHex, '--json');
    const inspected = await cli('inspect', signed.signedFragment, '--json');

    expect(inspected.signed).toBe(true);
    expect(inspected.site.pubkey).toBe(material.nowherePubkey);
    expect(inspected.signaturePubkeyHex).toBe(getPublicKey(Buffer.from(material.secretHex, 'hex')));
  });
});

function fragmentToUrl(fragment: string): string {
  return `https://hostednowhere.com/s#${fragment}`;
}
