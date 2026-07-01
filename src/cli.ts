import { bytesToBase64url, bytesToHex, decryptFragment, encryptFragment, hexToBytes } from '@nowhere/codec';
import { Command } from 'commander';
import { finalizeEvent } from 'nostr-tools/pure';
import { DEFAULT_RENDERER_ORIGIN } from './lib/constants.js';
import {
  computeVerificationSummary,
  fragmentToUrl,
  normalizeToFragment,
  resolveSiteInput,
} from './lib/fragments.js';
import { describeSecret, generateSecretMaterial } from './lib/keys.js';
import { printOutput } from './lib/output.js';

function fail(message: string): never {
  throw new Error(message);
}

async function signFragmentWithSecret(input: string, secret: string) {
  const resolved = await resolveSiteInput(input);
  if (!resolved.siteData) {
    fail(resolved.decodeError ?? 'Could not decode fragment before signing.');
  }

  const material = describeSecret(secret);
  if (resolved.siteData.pubkey && resolved.siteData.pubkey !== material.nowherePubkey) {
    fail('Wrong key: the provided secret does not match the public key embedded in this site.');
  }

  const unsignedFragment = resolved.unsignedFragment ?? resolved.decodedFragment;
  if (!unsignedFragment) {
    fail('Could not derive an unsigned fragment to sign.');
  }

  const signedEvent = finalizeEvent(
    {
      kind: 22242,
      created_at: 0,
      tags: [],
      content: unsignedFragment,
    },
    material.secretKey,
  );

  const signatureBytes = hexToBytes(signedEvent.sig);
  const fragmentBytes = Buffer.from(unsignedFragment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const combined = new Uint8Array(fragmentBytes.length + signatureBytes.length);
  combined.set(fragmentBytes, 0);
  combined.set(signatureBytes, fragmentBytes.length);
  const signedFragment = bytesToBase64url(combined);

  return {
    signedFragment,
    signedUrl: fragmentToUrl(signedFragment),
    unsignedFragment,
    unsignedUrl: fragmentToUrl(unsignedFragment),
    signerPubkeyHex: material.pubkeyHex,
    signerNpub: material.npub,
    signerNowherePubkey: material.nowherePubkey,
  };
}

const program = new Command();
program
  .name('nowhere')
  .description('CLI for Nowhere fragments, signing, and encryption.')
  .showHelpAfterError();

program
  .command('keygen')
  .description('Generate a fresh Nostr keypair suitable for Nowhere.')
  .option('--json', 'Emit JSON output.')
  .action((options) => {
    const material = generateSecretMaterial();
    printOutput(
      {
        secretHex: material.secretHex,
        nsec: material.nsec,
        pubkeyHex: material.pubkeyHex,
        npub: material.npub,
        nowherePubkey: material.nowherePubkey,
      },
      Boolean(options.json),
    );
  });

program
  .command('pubkey')
  .description('Derive public-key formats from an existing Nostr secret key.')
  .requiredOption('--secret <secret>', '64-char hex key or nsec.')
  .option('--json', 'Emit JSON output.')
  .action((options) => {
    const material = describeSecret(options.secret);
    printOutput(
      {
        pubkeyHex: material.pubkeyHex,
        npub: material.npub,
        nowherePubkey: material.nowherePubkey,
      },
      Boolean(options.json),
    );
  });

program
  .command('inspect')
  .description('Inspect a Nowhere fragment or URL.')
  .argument('<input>', 'Fragment or full Nowhere URL.')
  .option('--password <password>', 'Decrypt first using this password.')
  .option('--json', 'Emit JSON output.')
  .action(async (input, options) => {
    const resolved = await resolveSiteInput(input, options.password);
    if (!resolved.siteData) {
      fail(resolved.decodeError ?? 'Could not decode fragment.');
    }

    const verification = await computeVerificationSummary(resolved.siteData);
    printOutput(
      {
        inputKind: resolved.inputKind,
        normalizedFragment: resolved.normalizedFragment,
        decodedFragment: resolved.decodedFragment,
        unsignedFragment: resolved.unsignedFragment,
        url: resolved.decodedFragment ? fragmentToUrl(resolved.decodedFragment) : null,
        unsignedUrl: resolved.unsignedFragment ? fragmentToUrl(resolved.unsignedFragment) : null,
        decrypted: resolved.decrypted,
        signed: resolved.signed,
        signaturePubkeyHex: resolved.signaturePubkeyHex,
        site: {
          siteType: resolved.siteData.siteType,
          version: resolved.siteData.version,
          name: resolved.siteData.name,
          pubkey: resolved.siteData.pubkey ?? null,
          pubkeyHex: resolved.siteData.pubkey ? bytesToHex(Buffer.from(resolved.siteData.pubkey.replace(/-/g, '+').replace(/_/g, '/'), 'base64')) : null,
          rendererOrigin: DEFAULT_RENDERER_ORIGIN,
        },
        verification,
      },
      Boolean(options.json),
    );
  });

program
  .command('sign')
  .description('Sign an unsigned Nowhere fragment with an existing Nostr key.')
  .argument('<input>', 'Fragment or full Nowhere URL.')
  .requiredOption('--secret <secret>', '64-char hex key or nsec.')
  .option('--json', 'Emit JSON output.')
  .action(async (input, options) => {
    const result = await signFragmentWithSecret(input, options.secret);
    printOutput(result, Boolean(options.json));
  });

program
  .command('verify')
  .description('Verify a signed Nowhere fragment or URL.')
  .argument('<input>', 'Fragment or full Nowhere URL.')
  .option('--password <password>', 'Decrypt first using this password.')
  .option('--json', 'Emit JSON output.')
  .action(async (input, options) => {
    const resolved = await resolveSiteInput(input, options.password);
    if (!resolved.siteData) {
      fail(resolved.decodeError ?? 'Could not decode fragment.');
    }

    const verification = await computeVerificationSummary(resolved.siteData);
    printOutput(
      {
        signed: resolved.signed,
        signaturePubkeyHex: resolved.signaturePubkeyHex,
        unsignedFragment: resolved.unsignedFragment,
        unsignedUrl: resolved.unsignedFragment ? fragmentToUrl(resolved.unsignedFragment) : null,
        verification,
      },
      Boolean(options.json),
    );
  });

program
  .command('encrypt')
  .description('Encrypt a Nowhere fragment or URL with a password.')
  .argument('<input>', 'Fragment or full Nowhere URL.')
  .requiredOption('--password <password>', 'Password used to encrypt the fragment.')
  .option('--json', 'Emit JSON output.')
  .action(async (input, options) => {
    const { fragment } = normalizeToFragment(input);
    const encryptedFragment = await encryptFragment(fragment, options.password);
    printOutput(
      {
        encryptedFragment,
        encryptedUrl: fragmentToUrl(encryptedFragment),
      },
      Boolean(options.json),
    );
  });

program
  .command('decrypt')
  .description('Decrypt a Nowhere fragment or URL with a password.')
  .argument('<input>', 'Encrypted fragment or full Nowhere URL.')
  .requiredOption('--password <password>', 'Password used to decrypt the fragment.')
  .option('--json', 'Emit JSON output.')
  .action(async (input, options) => {
    const { fragment } = normalizeToFragment(input);
    const decrypted = await decryptFragment(fragment, options.password);
    printOutput(
      {
        fragment: decrypted,
        url: fragmentToUrl(decrypted),
      },
      Boolean(options.json),
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
