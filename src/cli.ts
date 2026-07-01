import { bytesToBase64url, bytesToHex, decryptFragment, encryptFragment, hexToBytes } from '@nowhere/codec';
import { Command } from 'commander';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildSite, deepMerge, type ToolSlug } from './lib/builders.js';
import { DEFAULT_RENDERER_ORIGIN } from './lib/constants.js';
import {
  computeVerificationSummary,
  fragmentToUrl,
  normalizeToFragment,
  resolveSiteInput,
} from './lib/fragments.js';
import { readJsonInput } from './lib/io.js';
import { describeSecret, generateSecretMaterial } from './lib/keys.js';
import { printOutput } from './lib/output.js';

function fail(message: string): never {
  throw new Error(message);
}

const toolChoices: ToolSlug[] = [
  'store',
  'event',
  'fundraiser',
  'petition',
  'message',
  'drop',
  'art',
  'forum',
];

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

async function finalizePublish(
  fragment: string,
  signSecret?: string,
  encryptPassword?: string,
): Promise<{
  fragment: string;
  url: string;
  unsignedFragment: string;
  unsignedUrl: string;
  signed: boolean;
  encrypted: boolean;
  signedFragment: string | null;
  signedUrl: string | null;
  encryptedFragment: string | null;
  encryptedUrl: string | null;
}> {
  const unsignedFragment = fragment;
  const unsignedUrl = fragmentToUrl(unsignedFragment);
  let activeFragment = unsignedFragment;
  let signedFragment: string | null = null;
  let signedUrl: string | null = null;
  let encryptedFragment: string | null = null;
  let encryptedUrl: string | null = null;

  if (signSecret) {
    const signed = await signFragmentWithSecret(unsignedFragment, signSecret);
    signedFragment = signed.signedFragment;
    signedUrl = signed.signedUrl;
    activeFragment = signed.signedFragment;
  }

  if (encryptPassword) {
    encryptedFragment = await encryptFragment(activeFragment, encryptPassword);
    encryptedUrl = fragmentToUrl(encryptedFragment);
    activeFragment = encryptedFragment;
  }

  return {
    fragment: activeFragment,
    url: fragmentToUrl(activeFragment),
    unsignedFragment,
    unsignedUrl,
    signed: Boolean(signSecret),
    encrypted: Boolean(encryptPassword),
    signedFragment,
    signedUrl,
    encryptedFragment,
    encryptedUrl,
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
  .command('create')
  .description('Create one of the eight Nowhere site types from structured JSON input.')
  .argument('<tool>', `One of: ${toolChoices.join(', ')}`)
  .requiredOption('--input <path>', 'Path to JSON input, or "-" to read JSON from stdin.')
  .option('--sign-secret <secret>', 'Sign the generated site with this nsec or hex secret.')
  .option('--encrypt-password <password>', 'Encrypt the final fragment after signing, matching the web flow.')
  .option('--json', 'Emit JSON output.')
  .action(async (tool: string, options) => {
    if (!toolChoices.includes(tool as ToolSlug)) {
      fail(`Unsupported tool "${tool}". Expected one of: ${toolChoices.join(', ')}.`);
    }

    const raw = await readJsonInput(options.input);
    const built = await buildSite(tool as ToolSlug, raw);
    const published = await finalizePublish(
      built.fragment,
      options.signSecret,
      options.encryptPassword,
    );

    printOutput(
      {
        tool,
        siteType: tool === 'forum' ? 'discussion' : tool,
        inputPath: options.input,
        siteData: built.siteData,
        verification: built.verification,
        ...published,
      },
      Boolean(options.json),
    );
  });

program
  .command('update')
  .description('Import an existing Nowhere site, merge a JSON patch, and republish it.')
  .argument('<input>', 'Fragment or full Nowhere URL to import.')
  .requiredOption('--patch <path>', 'Path to JSON patch, or "-" to read JSON from stdin.')
  .option('--password <password>', 'Decrypt the existing site before applying the patch.')
  .option('--sign-secret <secret>', 'Sign the updated site with this nsec or hex secret.')
  .option('--encrypt-password <password>', 'Encrypt the updated fragment after signing.')
  .option('--json', 'Emit JSON output.')
  .action(async (input, options) => {
    const resolved = await resolveSiteInput(input, options.password);
    if (!resolved.siteData) {
      fail(resolved.decodeError ?? 'Could not decode the input site.');
    }

    const patch = await readJsonInput(options.patch);
    const tool = resolved.siteData.siteType === 'discussion'
      ? 'forum'
      : (resolved.siteData.siteType as ToolSlug);
    const merged = deepMerge(resolved.siteData, patch);
    const built = await buildSite(tool, merged);
    const published = await finalizePublish(
      built.fragment,
      options.signSecret,
      options.encryptPassword,
    );

    printOutput(
      {
        tool,
        sourceInput: input,
        patchPath: options.patch,
        siteData: built.siteData,
        verification: built.verification,
        ...published,
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
