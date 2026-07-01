import { bytesToBase64url, bytesToHex, decryptFragment, encryptFragment, hexToBytes } from '@nowhere/codec';
import { Command } from 'commander';
import { SimplePool } from 'nostr-tools/pool';
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
import { destroyPool, getPetitionRelays } from './lib/relay.js';
import {
  countPetitionSignatures,
  createSimplePoolPetitionTransport,
  fetchPetitionSignaturesForOwner,
  publishPetitionSignature,
} from './lib/petition-live.js';
import {
  listForumPosts,
  listPrivateChatMessages,
  listForumReplies,
  listForumTorrentReplies,
  listForumTorrents,
  listGeneralChatMessages,
  listRoomAnnouncements,
  listRoomChatMessages,
  publishForumPostFromInput,
  publishPrivateChatMessage,
  publishForumReplyFromInput,
  publishForumTorrentReplyFromInput,
  publishForumTorrentFromInput,
  publishGeneralChatMessage,
  publishRoomAnnouncement,
  publishRoomChatMessage,
} from './lib/forum-live.js';
import {
  createSimplePoolRelayClient,
  decryptOrderReceipt,
  fetchOrdersByIds,
  fetchCurrentStatus,
  fetchOrdersForSeller,
  type OrderReceipt,
  publishOrderReceipt,
  publishStoreStatus,
  verifyStoreOrderPayload,
} from './lib/store-live.js';

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

async function withStoreRelayClient<T>(
  fn: (relayClient: ReturnType<typeof createSimplePoolRelayClient>) => Promise<T>,
): Promise<T> {
  const pool = new SimplePool();
  const relayClient = createSimplePoolRelayClient(pool);
  try {
    return await fn(relayClient);
  } finally {
    pool.destroy();
  }
}

async function withPetitionTransport<T>(
  fn: (transport: ReturnType<typeof createSimplePoolPetitionTransport>) => Promise<T>,
): Promise<T> {
  const pool = new SimplePool();
  const transport = createSimplePoolPetitionTransport(pool);
  try {
    return await fn(transport);
  } finally {
    pool.destroy();
  }
}

async function withForumPoolCleanup<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    destroyPool();
  }
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function getRelayList(relays: string[] | undefined): string[] | undefined {
  return relays && relays.length > 0 ? relays : undefined;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(message);
  }

  return value as Record<string, unknown>;
}

async function readObjectInput(path: string, message: string): Promise<Record<string, unknown>> {
  return requireObject(await readJsonInput(path), message);
}

function readString(value: Record<string, unknown>, key: string, required = true): string | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    if (required) {
      fail(`Missing required field "${key}".`);
    }
    return undefined;
  }

  if (typeof candidate !== 'string') {
    fail(`Expected "${key}" to be a string.`);
  }

  return candidate;
}

function readNumber(value: Record<string, unknown>, key: string, required = true): number | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    if (required) {
      fail(`Missing required field "${key}".`);
    }
    return undefined;
  }

  if (typeof candidate !== 'number') {
    fail(`Expected "${key}" to be a number.`);
  }

  return candidate;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function readBoolean(value: Record<string, unknown>, key: string, required = true): boolean | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    if (required) {
      fail(`Missing required field "${key}".`);
    }
    return undefined;
  }

  if (typeof candidate !== 'boolean') {
    fail(`Expected "${key}" to be a boolean.`);
  }

  return candidate;
}

function readArray(value: Record<string, unknown>, key: string, required = true): unknown[] | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    if (required) {
      fail(`Missing required field "${key}".`);
    }
    return undefined;
  }

  if (!Array.isArray(candidate)) {
    fail(`Expected "${key}" to be an array.`);
  }

  return candidate;
}

function readStringRecord(value: Record<string, unknown>, key: string, required = true): Record<string, string> | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    if (required) {
      fail(`Missing required field "${key}".`);
    }
    return undefined;
  }

  const record = requireObject(candidate, `Expected "${key}" to be an object.`);
  return Object.fromEntries(
    Object.entries(record).map(([entryKey, entryValue]) => {
      if (typeof entryValue !== 'string') {
        fail(`Expected "${key}.${entryKey}" to be a string.`);
      }
      return [entryKey, entryValue];
    }),
  );
}

function readUnknownRecord(value: Record<string, unknown>, key: string, required = true): Record<string, unknown> | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) {
    if (required) {
      fail(`Missing required field "${key}".`);
    }
    return undefined;
  }

  return requireObject(candidate, `Expected "${key}" to be an object.`);
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

const store = program.command('store').description('Manage relay-backed store flows.');

store
  .command('order')
  .description('Publish an encrypted Nowhere store order and return the seller receipt.')
  .argument('<store>', 'Store fragment or full store URL.')
  .requiredOption('--input <path>', 'Path to a JSON order payload, or "-" for stdin.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON order payload.');
    const published = await withStoreRelayClient((relayClient) => publishOrderReceipt({
      storeUrl: storeInput,
      buyer: readStringRecord(payload, 'buyer') ?? {},
      items: (readArray(payload, 'items') ?? []).map((item, index) => {
        const entry = requireObject(item, `Expected "items[${index}]" to be an object.`);
        return {
          i: readNumber(entry, 'i') as number,
          qty: readNumber(entry, 'qty') as number,
          ...(readString(entry, 'v', false) ? { v: readString(entry, 'v', false) } : {}),
        };
      }),
      subtotal: toCents(readNumber(payload, 'subtotal') as number),
      shipping: toCents(readNumber(payload, 'shipping') as number),
      total: toCents(readNumber(payload, 'total') as number),
      totalSats: readNumber(payload, 'totalSats', false),
      exchangeRate: readNumber(payload, 'exchangeRate', false),
      rateSource: readString(payload, 'rateSource', false),
      paymentMethod: readString(payload, 'paymentMethod', false),
      paymentCurrency: readString(payload, 'paymentCurrency', false),
      paymentAmount: readNumber(payload, 'paymentAmount', false) !== undefined
        ? toCents(readNumber(payload, 'paymentAmount', false) as number)
        : undefined,
      orderId: readString(payload, 'orderId', false),
      timestamp: readNumber(payload, 'timestamp', false),
      relayList: getRelayList(options.relay),
    }, relayClient));

    printOutput(published, Boolean(options.json));
  });

const storeReceipt = store.command('receipt').description('Work with seller-visible store receipts.');

storeReceipt
  .command('decrypt')
  .description('Decrypt a Nowhere store receipt using the seller secret.')
  .requiredOption('--input <path>', 'Path to the receipt JSON, or "-" for stdin.')
  .requiredOption('--secret <secret>', 'Seller nsec or 64-char hex secret.')
  .option('--json', 'Emit JSON output.')
  .action(async (options) => {
    const receipt = await readJsonInput(options.input);
    const normalizedReceipt: string | OrderReceipt = typeof receipt === 'string'
      ? receipt
      : (() => {
          const record = requireObject(receipt, 'Expected a JSON receipt payload.');
          if (record.v !== 1 || typeof record.p !== 'string' || typeof record.c !== 'string') {
            fail('Expected the receipt payload to include v, p, and c fields.');
          }
          return {
            v: 1,
            p: record.p,
            c: record.c,
          };
        })();
    printOutput(
      decryptOrderReceipt(normalizedReceipt, options.secret),
      Boolean(options.json),
    );
  });

store
  .command('orders')
  .description('Fetch and decrypt seller-visible orders for a store.')
  .argument('<store>', 'Store fragment or full store URL.')
  .requiredOption('--secret <secret>', 'Seller nsec or 64-char hex secret.')
  .option('--order-id <id>', 'Only fetch specific order ids. Repeat to pass more than one.', collectOption, [])
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--since <unix>', 'Only fetch orders at or after this Unix timestamp.')
  .option('--until <unix>', 'Only fetch orders at or before this Unix timestamp.')
  .option('--limit <count>', 'Maximum number of events to inspect.')
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const requestedOrderIds = getRelayList(options.orderId);
    const fetched = await withStoreRelayClient((relayClient) => (
      requestedOrderIds && requestedOrderIds.length > 0
        ? fetchOrdersByIds({
            storeUrl: storeInput,
            sellerSecret: options.secret,
            orderIds: requestedOrderIds,
            relayList: getRelayList(options.relay),
          }, relayClient)
        : fetchOrdersForSeller({
            storeUrl: storeInput,
            sellerSecret: options.secret,
            relayList: getRelayList(options.relay),
            since: options.since ? Number.parseInt(options.since, 10) : undefined,
            until: options.until ? Number.parseInt(options.until, 10) : undefined,
            limit: options.limit ? Number.parseInt(options.limit, 10) : undefined,
          }, relayClient)
    ));

    printOutput(fetched, Boolean(options.json));
  });

store
  .command('verify')
  .description('Verify a store order, raw encrypted event, or seller receipt against the store configuration.')
  .argument('<store>', 'Store fragment or full store URL.')
  .requiredOption('--input <path>', 'Path to the receipt, order event, or raw order JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Seller nsec or 64-char hex secret. Required for receipts or encrypted order events.')
  .option('--received-sats <count>', 'Expected sats received in your wallet for sats-based payments.')
  .option('--store-sats-per-unit <value>', 'Override the historical sats-per-unit used for the store currency.')
  .option('--payment-sats-per-unit <value>', 'Override the historical sats-per-unit used for the payment currency.')
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const payload = await readJsonInput(options.input);
    printOutput(
      await verifyStoreOrderPayload({
        storeUrl: storeInput,
        payload,
        sellerSecret: options.secret,
        receivedSats: options.receivedSats ? Number.parseInt(options.receivedSats, 10) : undefined,
        storeRateOverride: options.storeSatsPerUnit
          ? { satsPerUnit: Number.parseFloat(options.storeSatsPerUnit), source: 'override' }
          : undefined,
        paymentRateOverride: options.paymentSatsPerUnit
          ? { satsPerUnit: Number.parseFloat(options.paymentSatsPerUnit), source: 'override' }
          : undefined,
      }),
      Boolean(options.json),
    );
  });

const storeStatus = store.command('status').description('Publish or inspect encrypted store status.');

storeStatus
  .command('publish')
  .description('Publish a store status payload for inventory-aware stores.')
  .argument('<store>', 'Store fragment or full store URL.')
  .requiredOption('--input <path>', 'Path to the status JSON, or "-" for stdin.')
  .requiredOption('--secret <secret>', 'Seller nsec or 64-char hex secret.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON status payload.');
    const published = await withStoreRelayClient((relayClient) => publishStoreStatus({
      storeUrl: storeInput,
      sellerSecret: options.secret,
      relayList: getRelayList(options.relay),
      payload: {
        v: 1,
        notice: readString(payload, 'notice', false),
        closed: readString(payload, 'closed', false),
        redirect: readString(payload, 'redirect', false),
        items: readUnknownRecord(payload, 'items', false) as Record<string, 0 | 1 | 2 | 3> | undefined,
        variants: readUnknownRecord(payload, 'variants', false) as Record<string, Record<string, 0 | 1 | 2 | 3>> | undefined,
        low: payload.low
          ? {
              warn: readBoolean(requireObject(payload.low, 'Expected "low" to be an object.'), 'warn', false),
              fields: readString(requireObject(payload.low, 'Expected "low" to be an object.'), 'fields', false),
              refund: readBoolean(requireObject(payload.low, 'Expected "low" to be an object.'), 'refund', false),
            }
          : undefined,
      },
    }, relayClient));

    printOutput(published, Boolean(options.json));
  });

storeStatus
  .command('fetch')
  .description('Fetch the current encrypted store status from relays.')
  .argument('<store>', 'Store fragment or full store URL.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    printOutput(
      await withStoreRelayClient((relayClient) => fetchCurrentStatus({
        storeUrl: storeInput,
        relayList: getRelayList(options.relay),
      }, relayClient)),
      Boolean(options.json),
    );
  });

const petition = program.command('petition').description('Manage petition relay flows.');

petition
  .command('sign')
  .description('Publish a petition signature payload, anonymously or with an existing Nostr key.')
  .argument('<petition>', 'Petition fragment or full petition URL.')
  .requiredOption('--input <path>', 'Path to the signature JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--pow-difficulty <bits>', 'Override the proof-of-work difficulty.', '20')
  .option('--json', 'Emit JSON output.')
  .action(async (petitionInput, options) => {
    const resolved = await resolveSiteInput(petitionInput);
    if (!resolved.siteData || resolved.siteData.siteType !== 'petition' || !resolved.decodedFragment) {
      fail('Expected a Nowhere petition URL or fragment.');
    }
    if (!resolved.siteData.pubkey) {
      fail('Petition is missing an owner pubkey.');
    }
    const siteData = resolved.siteData;
    const fragment = resolved.decodedFragment;
    const ownerPubkey = resolved.siteData.pubkey;

    const payload = await readObjectInput(options.input, 'Expected a JSON petition signature payload.');
    const relays = getRelayList(options.relay) ?? getPetitionRelays(siteData.tags);
    const published = await withPetitionTransport((transport) => publishPetitionSignature({
      payload,
      creatorPubkeyHex: bytesToHex(
        Buffer.from(ownerPubkey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      ),
      fragment,
      relays,
      secret: options.secret,
      powDifficulty: Number.parseInt(options.powDifficulty, 10),
      transport,
    }));

    printOutput(published, Boolean(options.json));
  });

petition
  .command('count')
  .description('Count signatures for a petition by its derived d-tag.')
  .argument('<petition>', 'Petition fragment or full petition URL.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (petitionInput, options) => {
    const resolved = await resolveSiteInput(petitionInput);
    if (!resolved.siteData || resolved.siteData.siteType !== 'petition' || !resolved.decodedFragment) {
      fail('Expected a Nowhere petition URL or fragment.');
    }
    const siteData = resolved.siteData;
    const fragment = resolved.decodedFragment;
    const relays = getRelayList(options.relay) ?? getPetitionRelays(siteData.tags);

    printOutput(
      await withPetitionTransport((transport) => countPetitionSignatures({
        fragment,
        relays,
        transport,
      })),
      Boolean(options.json),
    );
  });

petition
  .command('signatures')
  .description('Fetch and decrypt petition signatures using the owner secret.')
  .argument('<petition>', 'Petition fragment or full petition URL.')
  .requiredOption('--secret <secret>', 'Petition owner nsec or 64-char hex secret.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--pow-difficulty <bits>', 'Override the proof-of-work difficulty.', '20')
  .option('--json', 'Emit JSON output.')
  .action(async (petitionInput, options) => {
    const resolved = await resolveSiteInput(petitionInput);
    if (!resolved.siteData || resolved.siteData.siteType !== 'petition' || !resolved.decodedFragment) {
      fail('Expected a Nowhere petition URL or fragment.');
    }
    const siteData = resolved.siteData;
    const fragment = resolved.decodedFragment;
    const relays = getRelayList(options.relay) ?? getPetitionRelays(siteData.tags);

    printOutput(
      await withPetitionTransport((transport) => fetchPetitionSignaturesForOwner({
        fragment,
        ownerSecret: options.secret,
        relays,
        powDifficulty: Number.parseInt(options.powDifficulty, 10),
        transport,
      })),
      Boolean(options.json),
    );
  });

const forum = program.command('forum').description('Manage forum relay flows.');

forum
  .command('post')
  .description('Publish a forum post.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--input <path>', 'Path to the post JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON forum post payload.');
    printOutput(
      await withForumPoolCleanup(() => publishForumPostFromInput({
        forumInput,
        topic: readString(payload, 'topic', false),
        title: readString(payload, 'title') as string,
        body: readString(payload, 'body', false),
        link: readString(payload, 'link', false),
        secret: options.secret,
        salt: options.salt,
        relays: getRelayList(options.relay),
      })),
      Boolean(options.json),
    );
  });

forum
  .command('posts')
  .description('List forum posts, optionally scoped to a topic.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .option('--topic <topic>', 'Only list posts for this topic.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    printOutput(
      {
        posts: await withForumPoolCleanup(() => listForumPosts({
          forumInput,
          topic: options.topic,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
      },
      Boolean(options.json),
    );
  });

forum
  .command('reply')
  .description('Publish a forum reply to an existing post.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--post-event <id>', 'Target post event id.')
  .requiredOption('--input <path>', 'Path to the reply JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON forum reply payload.');
    printOutput(
      await withForumPoolCleanup(() => publishForumReplyFromInput({
        forumInput,
        postEventId: options.postEvent,
        body: readString(payload, 'body') as string,
        quotedReplyId: readString(payload, 'quotedReplyId', false),
        secret: options.secret,
        salt: options.salt,
        relays: getRelayList(options.relay),
      })),
      Boolean(options.json),
    );
  });

forum
  .command('replies')
  .description('List replies for a forum post.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--post-event <id>', 'Target post event id.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    printOutput(
      {
        replies: await withForumPoolCleanup(() => listForumReplies({
          forumInput,
          postEventId: options.postEvent,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
      },
      Boolean(options.json),
    );
  });

const forumTorrent = forum.command('torrent').description('Publish or inspect forum torrent entries.');

forumTorrent
  .command('publish')
  .description('Publish a forum torrent payload.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--input <path>', 'Path to the torrent JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON torrent payload.');
    printOutput(
      await withForumPoolCleanup(() => publishForumTorrentFromInput({
        forumInput,
        secret: options.secret,
        salt: options.salt,
        relays: getRelayList(options.relay),
        torrent: {
          x: readString(payload, 'x') as string,
          title: readString(payload, 'title') as string,
          description: readString(payload, 'description', false),
          files: (readArray(payload, 'files') ?? []).map((entry, index) => {
            const file = requireObject(entry, `Expected "files[${index}]" to be an object.`);
            return {
              path: readString(file, 'path') as string,
              size: readNumber(file, 'size') as number,
            };
          }),
          trackers: (readArray(payload, 'trackers') ?? []).map((entry, index) => {
            if (typeof entry !== 'string') {
              fail(`Expected "trackers[${index}]" to be a string.`);
            }
            return entry;
          }),
          category: readString(payload, 'category') as string,
          refs: (readArray(payload, 'refs') ?? []).map((entry, index) => {
            if (typeof entry !== 'string') {
              fail(`Expected "refs[${index}]" to be a string.`);
            }
            return entry;
          }),
        },
      })),
      Boolean(options.json),
    );
  });

forumTorrent
  .command('reply')
  .description('Publish a reply to an existing forum torrent entry.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--torrent-event <id>', 'Target torrent event id.')
  .requiredOption('--input <path>', 'Path to the torrent reply JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON torrent reply payload.');
    printOutput(
      await withForumPoolCleanup(() => publishForumTorrentReplyFromInput({
        forumInput,
        torrentEventId: options.torrentEvent,
        body: readString(payload, 'body') as string,
        quotedReplyId: readString(payload, 'quotedReplyId', false),
        secret: options.secret,
        salt: options.salt,
        relays: getRelayList(options.relay),
      })),
      Boolean(options.json),
    );
  });

forumTorrent
  .command('replies')
  .description('List replies for a forum torrent entry.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--torrent-event <id>', 'Target torrent event id.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    printOutput(
      {
        replies: await withForumPoolCleanup(() => listForumTorrentReplies({
          forumInput,
          torrentEventId: options.torrentEvent,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
      },
      Boolean(options.json),
    );
  });

forum
  .command('torrents')
  .description('List published forum torrent entries.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    printOutput(
      {
        torrents: await withForumPoolCleanup(() => listForumTorrents({
          forumInput,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
      },
      Boolean(options.json),
    );
  });

const forumChat = forum.command('chat').description('Publish or inspect forum chat messages.');

forumChat
  .command('send')
  .description('Publish a general forum chat message.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--input <path>', 'Path to the chat JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--session-secret <secret>', 'Optional stable session secret to advertise for private chat.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON chat payload.');
    printOutput(
      await withForumPoolCleanup(() => publishGeneralChatMessage({
        forumInput,
        message: readString(payload, 'message') as string,
        secret: options.secret,
        sessionSecret: options.sessionSecret,
        salt: options.salt,
        relays: getRelayList(options.relay),
      })),
      Boolean(options.json),
    );
  });

const forumPrivate = forum.command('private').description('Publish or inspect private forum chat messages.');

forumPrivate
  .command('send')
  .description('Publish an encrypted private forum message to a session pubkey.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--recipient-session-pubkey <pubkey>', 'Recipient stable session pubkey (hex).')
  .requiredOption('--input <path>', 'Path to the private chat JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON private chat payload.');
    printOutput(
      await withForumPoolCleanup(() => publishPrivateChatMessage({
        forumInput,
        recipientSessionPubkey: options.recipientSessionPubkey,
        message: readString(payload, 'message') as string,
        secret: options.secret,
        salt: options.salt,
        relays: getRelayList(options.relay),
      })),
      Boolean(options.json),
    );
  });

forumPrivate
  .command('list')
  .description('List encrypted private forum messages for a stable session secret.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--session-secret <secret>', 'Stable session secret used to decrypt incoming private messages.')
  .option('--peer-pubkey <pubkey>', 'Only include messages from this author pubkey.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    printOutput(
      {
        messages: await withForumPoolCleanup(() => listPrivateChatMessages({
          forumInput,
          sessionSecret: options.sessionSecret,
          peerPubkey: options.peerPubkey,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
      },
      Boolean(options.json),
    );
  });

forumChat
  .command('list')
  .description('List general forum chat messages.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    printOutput(
      {
        messages: await withForumPoolCleanup(() => listGeneralChatMessages({
          forumInput,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
      },
      Boolean(options.json),
    );
  });

const forumRoom = forum.command('room').description('Publish or inspect private forum room announcements and messages.');

forumRoom
  .command('announce')
  .description('Publish a room announcement with the shared access code.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--input <path>', 'Path to the room announcement JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON room announcement payload.');
    printOutput(
      await withForumPoolCleanup(() => publishRoomAnnouncement({
        forumInput,
        roomName: readString(payload, 'roomName') as string,
        accessCode: readString(payload, 'accessCode') as string,
        secret: options.secret,
        salt: options.salt,
        relays: getRelayList(options.relay),
      })),
      Boolean(options.json),
    );
  });

forumRoom
  .command('announcements')
  .description('List room announcements visible to the forum key.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    printOutput(
      {
        announcements: await withForumPoolCleanup(() => listRoomAnnouncements({
          forumInput,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
      },
      Boolean(options.json),
    );
  });

forumRoom
  .command('send')
  .description('Publish an encrypted forum room message.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--input <path>', 'Path to the room chat JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const payload = await readObjectInput(options.input, 'Expected a JSON room chat payload.');
    printOutput(
      await withForumPoolCleanup(() => publishRoomChatMessage({
        forumInput,
        roomName: readString(payload, 'roomName') as string,
        accessCode: readString(payload, 'accessCode') as string,
        message: readString(payload, 'message') as string,
        secret: options.secret,
        salt: options.salt,
        relays: getRelayList(options.relay),
      })),
      Boolean(options.json),
    );
  });

forumRoom
  .command('list')
  .description('List encrypted forum room messages.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--room-name <name>', 'Room name.')
  .requiredOption('--access-code <code>', 'Room access code.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    printOutput(
      {
        messages: await withForumPoolCleanup(() => listRoomChatMessages({
          forumInput,
          roomName: options.roomName,
          accessCode: options.accessCode,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
      },
      Boolean(options.json),
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
