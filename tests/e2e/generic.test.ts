import { encodeMessage, encryptFragment, type MessageData } from '@nowhere/codec';
import { describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getPublicKey } from 'nostr-tools/pure';
import { generateSecretMaterial } from '../../src/lib/keys.js';

const execFileAsync = promisify(execFile);
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const cli = async (...args: string[]) => {
  const result = await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], {
    cwd,
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

async function encryptToLeadingDash(fragment: string, passwordPrefix: string): Promise<{
  encryptedFragment: string;
  password: string;
}> {
  for (let index = 0; index < 4096; index += 1) {
    const password = `${passwordPrefix}-${index}`;
    const encryptedFragment = await encryptFragment(fragment, password);
    if (encryptedFragment.startsWith('-')) {
      return { encryptedFragment, password };
    }
  }

  throw new Error('Could not generate a leading-dash encrypted fragment.');
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

    const decrypted = await cli('decrypt', encrypted.encryptedUrl, '--password', 'correct horse battery staple', '--json');
    expect(decrypted.fragment).toBe(fragment);
  });

  test('decrypt accepts a leading-dash encrypted fragment as the first positional argument', async () => {
    const material = generateSecretMaterial();
    const fragment = encodeMessage(sampleMessage(material.nowherePubkey)).fragment;
    const { encryptedFragment, password } = await encryptToLeadingDash(fragment, 'decrypt-positional');

    const decrypted = await cli('decrypt', encryptedFragment, '--password', password, '--json');

    expect(decrypted.fragment).toBe(fragment);
    expect(decrypted.url).toBe(fragmentToUrl(fragment));
  });

  test('inspect and verify accept leading-dash encrypted fragments as positional arguments', async () => {
    const material = generateSecretMaterial();
    const fragment = encodeMessage(sampleMessage(material.nowherePubkey)).fragment;
    const signed = await cli('sign', fragment, '--secret', material.secretHex, '--json');
    const { encryptedFragment, password } = await encryptToLeadingDash(signed.signedFragment, 'inspect-verify-positional');

    const inspected = await cli('inspect', encryptedFragment, '--password', password, '--json');
    const verified = await cli('verify', encryptedFragment, '--password', password, '--json');

    expect(inspected.decrypted).toBe(true);
    expect(inspected.signed).toBe(true);
    expect(inspected.site.name).toBe('Alice');
    expect(verified.signed).toBe(true);
    expect(verified.signaturePubkeyHex).toBe(material.pubkeyHex);
    expect(verified.unsignedFragment).toBe(fragment);
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
