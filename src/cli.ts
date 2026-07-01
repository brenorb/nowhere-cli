import { bytesToBase64url, bytesToHex, decryptFragment, encryptFragment, hexToBytes, type SiteData } from '@nowhere/codec';
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import {
  connectSignerViaBunker,
  disconnectActiveSigner,
  getActiveSignerStatus,
  requireActiveSigner,
  signerFromSecret,
  type CliSigner,
} from './lib/active-signer.js';
import { buildSite, deepMerge, type ToolSlug } from './lib/builders.js';
import { DEFAULT_RENDERER_ORIGIN } from './lib/constants.js';
import {
  computeVerificationSummary,
  fragmentToUrl,
  normalizeToFragment,
  resolveSiteInput,
} from './lib/fragments.js';
import { createFundraiserDonationInvoice, listFundraiserDonationMethods } from './lib/fundraiser-donate.js';
import { formatPetitionSignaturesCsv, formatStoreOrdersCsv } from './lib/csv-export.js';
import { readJsonInput } from './lib/io.js';
import { describeSecret, generateSecretMaterial } from './lib/keys.js';
import { resolveCreateRawInput, type CreateCommandOptions } from './lib/create-long-form.js';
import { createMessageTipInvoice, listMessageTipMethods } from './lib/message-tips.js';
import { printOutput } from './lib/output.js';
import { destroyPool, getPetitionRelays } from './lib/relay.js';
import {
  countPetitionSignatures,
  createSimplePoolPetitionTransport,
  fetchPetitionSignaturesForOwner,
  publishPetitionSignature,
} from './lib/petition-live.js';
import {
  buildTorrentDataFromParsedTorrent,
  checkForumTorrentSubmission,
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
  buildForumWotSet,
  checkForumWotAccess,
  getForumModerationConfig,
  passesForumModeration,
} from './lib/forum-moderation.js';
import { beginStoreCheckout, quoteStoreCheckout } from './lib/store-checkout.js';
import { parseTorrentFile } from './lib/torrent-bencode.js';
import {
  createSimplePoolRelayClient,
  decryptOrderReceipt,
  decryptOrderReceiptWithAccess,
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

function printTextOutput(value: string): void {
  process.stdout.write(`${value}\n`);
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
  return signFragmentWithSigner(input, signerFromSecret(secret));
}

async function signFragmentWithSigner(input: string, signer: CliSigner) {
  const resolved = await resolveSiteInput(input);
  if (!resolved.siteData) {
    fail(resolved.decodeError ?? 'Could not decode fragment before signing.');
  }

  const signerPubkeyHex = await signer.getPublicKey();
  const signerNowherePubkey = bytesToBase64url(hexToBytes(signerPubkeyHex));
  if (resolved.siteData.pubkey && resolved.siteData.pubkey !== signerNowherePubkey) {
    fail('Wrong key: the provided secret does not match the public key embedded in this site.');
  }

  const unsignedFragment = resolved.unsignedFragment ?? resolved.decodedFragment;
  if (!unsignedFragment) {
    fail('Could not derive an unsigned fragment to sign.');
  }

  const signedEvent = await signer.signEvent({
    kind: 22242,
    created_at: 0,
    tags: [],
    content: unsignedFragment,
  });

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
    signerPubkeyHex,
    signerNpub: nip19.npubEncode(signerPubkeyHex),
    signerNowherePubkey,
  };
}

async function finalizePublish(
  fragment: string,
  signSecret?: string,
  signer?: CliSigner,
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

  if (signSecret || signer) {
    const signed = signSecret
      ? await signFragmentWithSecret(unsignedFragment, signSecret)
      : await signFragmentWithSigner(unsignedFragment, signer as CliSigner);
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
    signed: Boolean(signSecret || signer),
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

async function resolveRuntimeSiteInput<TExpected extends 'store' | 'petition' | 'fundraiser' | 'message' | 'discussion'>(
  input: string,
  expectedType: TExpected,
  password?: string,
): Promise<{
  resolved: Awaited<ReturnType<typeof resolveSiteInput>>;
  siteData: Extract<SiteData, { siteType: TExpected }>;
  fragment: string;
  url: string;
}> {
  const resolved = await resolveSiteInput(input, password);
  const label = expectedType === 'discussion' ? 'forum' : expectedType;
  if (!resolved.siteData || resolved.siteData.siteType !== expectedType) {
    fail(`Expected a Nowhere ${label} URL or fragment.`);
  }

  const fragment = resolved.unsignedFragment ?? resolved.decodedFragment;
  if (!fragment) {
    fail(`Could not resolve the ${label} fragment.`);
  }

  return {
    resolved,
    siteData: resolved.siteData as Extract<SiteData, { siteType: TExpected }>,
    fragment,
    url: fragmentToUrl(fragment),
  };
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function getRegisteredArgumentCount(command: Command): number {
  const candidate = command as Command & { registeredArguments?: unknown[] };
  return Array.isArray(candidate.registeredArguments) ? candidate.registeredArguments.length : 0;
}

function collectOptionSpecs(command: Command): Map<string, boolean> {
  const specs = new Map<string, boolean>();
  for (let current: Command | null = command; current; current = current.parent ?? null) {
    for (const option of current.options) {
      const takesValue = option.flags.includes('<') || option.flags.includes('[');
      if (option.short) {
        specs.set(option.short, takesValue);
      }
      if (option.long) {
        specs.set(option.long, takesValue);
      }
    }
  }
  specs.set('-h', false);
  specs.set('--help', false);
  return specs;
}

function findArgumentTokenIndex(tokens: string[], startIndex: number, optionSpecs: Map<string, boolean>): number {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (token === '--') {
      return index + 1 < tokens.length ? index + 1 : -1;
    }
    if (!token.startsWith('-') || token === '-') {
      return index;
    }

    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    const takesValue = optionSpecs.get(flag);
    if (takesValue === undefined) {
      return index;
    }

    index += takesValue && !token.includes('=') ? 2 : 1;
  }

  return -1;
}

function normalizeLeadingDashPositionalArg(root: Command, argv: string[]): string[] {
  const tokens = argv.slice(2);
  let command = root;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (token.startsWith('-')) {
      break;
    }
    const subcommand = command.commands.find((candidate) => (
      candidate.name() === token || candidate.aliases().includes(token)
    ));
    if (!subcommand) {
      break;
    }
    command = subcommand;
    index += 1;
  }

  if (getRegisteredArgumentCount(command) !== 1) {
    return argv;
  }

  const optionSpecs = collectOptionSpecs(command);
  const argumentIndex = findArgumentTokenIndex(tokens, index, optionSpecs);
  if (argumentIndex < 0) {
    return argv;
  }

  const candidate = tokens[argumentIndex] as string;
  if (!candidate.startsWith('-') || candidate === '-') {
    return argv;
  }

  const normalizedFlag = candidate.includes('=') ? candidate.slice(0, candidate.indexOf('=')) : candidate;
  if (optionSpecs.has(normalizedFlag)) {
    return argv;
  }

  const reordered = [
    ...tokens.slice(0, argumentIndex),
    ...tokens.slice(argumentIndex + 1),
    '--',
    candidate,
  ];
  return [argv[0] as string, argv[1] as string, ...reordered];
}

function failOnSignerConflict(secret: string | undefined, useSigner: boolean | undefined, secretLabel = '--secret'): void {
  if (secret && useSigner) {
    fail(`Choose either ${secretLabel} or --use-signer, not both.`);
  }
}

async function resolveOptionalSigner(secret: string | undefined, useSigner: boolean | undefined, secretLabel = '--secret'): Promise<CliSigner | undefined> {
  failOnSignerConflict(secret, useSigner, secretLabel);
  if (secret) {
    return signerFromSecret(secret);
  }
  if (useSigner) {
    return requireActiveSigner();
  }
  return undefined;
}

async function resolveRequiredSigner(secret: string | undefined, useSigner: boolean | undefined, secretLabel = '--secret'): Promise<CliSigner> {
  const signer = await resolveOptionalSigner(secret, useSigner, secretLabel);
  if (!signer) {
    fail(`Pass either ${secretLabel} or --use-signer.`);
  }
  return signer;
}

async function closeSignerQuietly(signer: CliSigner | undefined): Promise<void> {
  if (!signer) {
    return;
  }
  try {
    await signer.disconnect();
  } catch {
    // Swallow signer teardown failures on process exit.
  }
  destroyPool();
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

function readStringList(values: unknown[] | undefined, key: string): string[] {
  return (values ?? []).map((entry, index) => {
    if (typeof entry !== 'string') {
      fail(`Expected "${key}[${index}]" to be a string.`);
    }
    return entry;
  });
}

function readTorrentPayload(payload: Record<string, unknown>) {
  return {
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
    trackers: readStringList(readArray(payload, 'trackers', false), 'trackers'),
    category: readString(payload, 'category') as string,
    refs: readStringList(readArray(payload, 'refs', false), 'refs'),
  };
}

async function buildTorrentFromFileOptions(options: {
  torrentFile: string;
  category: string;
  title?: string;
  description?: string;
  tracker?: string[];
  ref?: string[];
}) {
  const parsed = parseTorrentFile(await readFile(options.torrentFile));
  return buildTorrentDataFromParsedTorrent(parsed, {
    category: options.category,
    title: options.title,
    description: options.description,
    trackers: getRelayList(options.tracker),
    refs: getRelayList(options.ref),
  });
}

async function resolveTorrentSubmission(options: {
  input?: string;
  torrentFile?: string;
  category?: string;
  title?: string;
  description?: string;
  tracker?: string[];
  ref?: string[];
}) {
  if (options.input && options.torrentFile) {
    fail('Use either --input or --torrent-file, not both.');
  }

  if (options.input) {
    const payload = await readObjectInput(options.input, 'Expected a JSON torrent payload.');
    return readTorrentPayload(payload);
  }

  if (options.torrentFile) {
    if (!options.category) {
      fail('--category is required when using --torrent-file.');
    }
    return buildTorrentFromFileOptions({
      torrentFile: options.torrentFile,
      category: options.category,
      title: options.title,
      description: options.description,
      tracker: options.tracker,
      ref: options.ref,
    });
  }

  fail('Provide either --input or --torrent-file.');
}

function readOrderItems(value: Record<string, unknown>, key = 'items'): Array<{ i: number; qty: number; v?: string }> {
  return (readArray(value, key) ?? []).map((entry, index) => {
    const item = requireObject(entry, `Expected "${key}[${index}]" to be an object.`);
    return {
      i: readNumber(item, 'i') as number,
      qty: readNumber(item, 'qty') as number,
      v: readString(item, 'v', false),
    };
  });
}

async function filterModeratedEntries<T>(options: {
  forumInput: string;
  scope: 'post' | 'reply' | 'chat' | 'torrent';
  entries: T[];
  profileRelays?: string[];
  getAuthor: (entry: T) => string;
  getText: (entry: T) => string;
}): Promise<T[]> {
  const config = await getForumModerationConfig(options.forumInput, options.scope, options.profileRelays);
  const wotSet = await buildForumWotSet(config);
  return options.entries.filter((entry) => passesForumModeration(
    options.getAuthor(entry),
    options.getText(entry),
    wotSet,
    config.bannedWords,
  ));
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

const signerCommand = program
  .command('signer')
  .description('Manage the persisted remote signer session used for existing-key flows.');

signerCommand
  .command('connect')
  .description('Connect to a remote NIP-46 signer via bunker URI or name@domain and persist the session.')
  .requiredOption('--bunker <input>', 'bunker:// URI or name@domain exposed by the signer.')
  .option('--json', 'Emit JSON output.')
  .action(async (options) => {
    const signer = await connectSignerViaBunker(options.bunker);
    try {
      printOutput(
        {
          connected: true,
          type: signer.type,
          pubkeyHex: signer.pubkeyHex,
          npub: nip19.npubEncode(signer.pubkeyHex),
        },
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

signerCommand
  .command('status')
  .description('Inspect the currently persisted remote signer session.')
  .option('--json', 'Emit JSON output.')
  .action(async (options) => {
    try {
      printOutput(await getActiveSignerStatus(), Boolean(options.json));
    } finally {
      destroyPool();
    }
  });

signerCommand
  .command('disconnect')
  .description('Forget the persisted remote signer session.')
  .option('--json', 'Emit JSON output.')
  .action(async (options) => {
    try {
      printOutput(await disconnectActiveSigner(), Boolean(options.json));
    } finally {
      destroyPool();
    }
  });

program
  .command('sign')
  .description('Sign an unsigned Nowhere fragment with an existing Nostr key.')
  .argument('<input>', 'Fragment or full Nowhere URL.')
  .option('--secret <secret>', '64-char hex key or nsec.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--json', 'Emit JSON output.')
  .action(async (input, options) => {
    const signer = await resolveRequiredSigner(options.secret, options.useSigner);
    try {
      printOutput(await signFragmentWithSigner(input, signer), Boolean(options.json));
    } finally {
      await closeSignerQuietly(signer);
    }
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
  .description('Create one of the eight Nowhere site types from JSON input or long-form CLI flags.')
  .argument('<tool>', `One of: ${toolChoices.join(', ')}`)
  .option('--input <path>', 'Path to JSON input, or "-" to read JSON from stdin.')
  .option('--name <text>', 'Site name for long-form builder mode.')
  .option('--description <text>', 'Site description/body for long-form builder mode.')
  .option('--description-file <path>', 'Read the site description/body from this file instead of --description.')
  .option('--image <url>', 'Site image URL for long-form builder mode.')
  .option('--pubkey <pubkey>', 'Owner pubkey as npub, hex, or Nowhere base64url for long-form builder mode.')
  .option('--tag <tag>', 'Repeatable tag in KEY or KEY=VALUE form for long-form builder mode.', collectOption, [])
  .option(
    '--item <spec>',
    'Repeatable store item spec like "name=Sticker Pack;price=7.5;description=Matte vinyl;tag=f".',
    collectOption,
    [],
  )
  .option('--svg <svg>', 'Inline SVG markup for art creation in long-form builder mode.')
  .option('--svg-file <path>', 'Read SVG markup for art creation from this file instead of --svg.')
  .option('--sign-secret <secret>', 'Sign the generated site with this nsec or hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of --sign-secret.')
  .option('--encrypt-password <password>', 'Encrypt the final fragment after signing, matching the web flow.')
  .option('--json', 'Emit JSON output.')
  .action(async (tool: string, options) => {
    if (!toolChoices.includes(tool as ToolSlug)) {
      fail(`Unsupported tool "${tool}". Expected one of: ${toolChoices.join(', ')}.`);
    }

    const signer = await resolveOptionalSigner(options.signSecret, options.useSigner, '--sign-secret');
    try {
      const raw = await resolveCreateRawInput(tool as ToolSlug, options as CreateCommandOptions, signer);
      const built = await buildSite(tool as ToolSlug, raw);
      const published = await finalizePublish(
        built.fragment,
        options.signSecret,
        signer,
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
    } finally {
      await closeSignerQuietly(signer);
    }
  });

program
  .command('update')
  .description('Import an existing Nowhere site, merge a JSON patch, and republish it.')
  .argument('<input>', 'Fragment or full Nowhere URL to import.')
  .requiredOption('--patch <path>', 'Path to JSON patch, or "-" to read JSON from stdin.')
  .option('--password <password>', 'Decrypt the existing site before applying the patch.')
  .option('--sign-secret <secret>', 'Sign the updated site with this nsec or hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of --sign-secret.')
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
    const signer = await resolveOptionalSigner(options.signSecret, options.useSigner, '--sign-secret');
    try {
      const published = await finalizePublish(
        built.fragment,
        options.signSecret,
        signer,
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
    } finally {
      await closeSignerQuietly(signer);
    }
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
  .option('--password <password>', 'Decrypt the store first using this password.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const store = await resolveRuntimeSiteInput(storeInput, 'store', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON order payload.');
    const published = await withStoreRelayClient((relayClient) => publishOrderReceipt({
      storeUrl: store.url,
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
  .description('Decrypt a Nowhere store receipt using the seller secret or active signer.')
  .requiredOption('--input <path>', 'Path to the receipt JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Seller nsec or 64-char hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
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
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        signer
          ? await decryptOrderReceiptWithAccess(normalizedReceipt, undefined, signer)
          : decryptOrderReceipt(normalizedReceipt, options.secret),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

store
  .command('orders')
  .description('Fetch and decrypt seller-visible orders for a store.')
  .argument('<store>', 'Store fragment or full store URL.')
  .option('--secret <secret>', 'Seller nsec or 64-char hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the store first using this password.')
  .option('--order-id <id>', 'Only fetch specific order ids. Repeat to pass more than one.', collectOption, [])
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--since <unix>', 'Only fetch orders at or after this Unix timestamp.')
  .option('--until <unix>', 'Only fetch orders at or before this Unix timestamp.')
  .option('--limit <count>', 'Maximum number of events to inspect.')
  .option('--csv', 'Emit CSV output.')
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const requestedOrderIds = getRelayList(options.orderId);
    const store = await resolveRuntimeSiteInput(storeInput, 'store', options.password);
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      const fetched = await withStoreRelayClient((relayClient) => (
        requestedOrderIds && requestedOrderIds.length > 0
          ? fetchOrdersByIds({
              storeUrl: store.url,
              sellerSecret: options.secret,
              sellerSigner: signer,
              orderIds: requestedOrderIds,
              relayList: getRelayList(options.relay),
            }, relayClient)
          : fetchOrdersForSeller({
              storeUrl: store.url,
              sellerSecret: options.secret,
              sellerSigner: signer,
              relayList: getRelayList(options.relay),
              since: options.since ? Number.parseInt(options.since, 10) : undefined,
              until: options.until ? Number.parseInt(options.until, 10) : undefined,
              limit: options.limit ? Number.parseInt(options.limit, 10) : undefined,
            }, relayClient)
      ));

      if (options.csv) {
        printTextOutput(formatStoreOrdersCsv(fetched, store.siteData));
        return;
      }
      printOutput(fetched, Boolean(options.json));
    } finally {
      await closeSignerQuietly(signer);
    }
  });

store
  .command('verify')
  .description('Verify a store order, raw encrypted event, or seller receipt against the store configuration.')
  .argument('<store>', 'Store fragment or full store URL.')
  .requiredOption('--input <path>', 'Path to the receipt, order event, or raw order JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Seller nsec or 64-char hex secret. Required for receipts or encrypted order events.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the store first using this password.')
  .option('--received-sats <count>', 'Expected sats received in your wallet for sats-based payments.')
  .option('--store-sats-per-unit <value>', 'Override the historical sats-per-unit used for the store currency.')
  .option('--payment-sats-per-unit <value>', 'Override the historical sats-per-unit used for the payment currency.')
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const store = await resolveRuntimeSiteInput(storeInput, 'store', options.password);
    const payload = await readJsonInput(options.input);
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await verifyStoreOrderPayload({
          storeUrl: store.url,
          payload,
          sellerSecret: options.secret,
          sellerSigner: signer,
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
    } finally {
      await closeSignerQuietly(signer);
    }
  });

const storeCheckout = store.command('checkout').description('Quote or begin the website-style checkout flow.');

storeCheckout
  .command('quote')
  .description('Compute checkout totals, field requirements, inventory gating, and payment methods.')
  .argument('<store>', 'Store fragment or full store URL.')
  .requiredOption('--cart <path>', 'Path to the checkout cart JSON, or "-" for stdin.')
  .option('--buyer-country <code>', 'Optional buyer country used for shipping and country validation.')
  .option('--password <password>', 'Decrypt the store first using this password.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const store = await resolveRuntimeSiteInput(storeInput, 'store', options.password);
    const cart = await readObjectInput(options.cart, 'Expected a JSON checkout cart payload.');
    printOutput(
      await withStoreRelayClient((relayClient) => quoteStoreCheckout({
        storeUrl: store.url,
        items: readOrderItems(cart),
        buyerCountry: options.buyerCountry,
        relayList: getRelayList(options.relay),
      }, relayClient)),
      Boolean(options.json),
    );
  });

storeCheckout
  .command('begin')
  .description('Start a checkout flow, publish the order, and return the invoice or manual instructions.')
  .argument('<store>', 'Store fragment or full store URL.')
  .requiredOption('--cart <path>', 'Path to the checkout cart JSON, or "-" for stdin.')
  .requiredOption('--buyer <path>', 'Path to the buyer JSON, or "-" for stdin.')
  .option('--method <id>', 'Payment method id, such as bitcoin, payid, or custom_0.', 'bitcoin')
  .option('--password <password>', 'Decrypt the store first using this password.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const store = await resolveRuntimeSiteInput(storeInput, 'store', options.password);
    const cart = await readObjectInput(options.cart, 'Expected a JSON checkout cart payload.');
    const buyer = await readObjectInput(options.buyer, 'Expected a JSON buyer payload.');
    printOutput(
      await withStoreRelayClient((relayClient) => beginStoreCheckout({
        storeUrl: store.url,
        items: readOrderItems(cart),
        buyer: Object.fromEntries(Object.entries(buyer).map(([key, value]) => [key, String(value)])),
        methodId: options.method,
        relayList: getRelayList(options.relay),
      }, relayClient)),
      Boolean(options.json),
    );
  });

const storeStatus = store.command('status').description('Publish or inspect encrypted store status.');

storeStatus
  .command('publish')
  .description('Publish a store status payload for inventory-aware stores.')
  .argument('<store>', 'Store fragment or full store URL.')
  .requiredOption('--input <path>', 'Path to the status JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Seller nsec or 64-char hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the store first using this password.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const store = await resolveRuntimeSiteInput(storeInput, 'store', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON status payload.');
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      const published = await withStoreRelayClient((relayClient) => publishStoreStatus({
        storeUrl: store.url,
        sellerSecret: options.secret,
        sellerSigner: signer,
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
    } finally {
      await closeSignerQuietly(signer);
    }
  });

storeStatus
  .command('fetch')
  .description('Fetch the current encrypted store status from relays.')
  .argument('<store>', 'Store fragment or full store URL.')
  .option('--password <password>', 'Decrypt the store first using this password.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (storeInput, options) => {
    const store = await resolveRuntimeSiteInput(storeInput, 'store', options.password);
    printOutput(
      await withStoreRelayClient((relayClient) => fetchCurrentStatus({
        storeUrl: store.url,
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
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the petition first using this password.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--pow-difficulty <bits>', 'Override the proof-of-work difficulty.', '20')
  .option('--json', 'Emit JSON output.')
  .action(async (petitionInput, options) => {
    const petition = await resolveRuntimeSiteInput(petitionInput, 'petition', options.password);
    if (!petition.siteData.pubkey) {
      fail('Petition is missing an owner pubkey.');
    }
    const siteData = petition.siteData;
    const ownerPubkey = petition.siteData.pubkey;

    const payload = await readObjectInput(options.input, 'Expected a JSON petition signature payload.');
    const relays = getRelayList(options.relay) ?? getPetitionRelays(siteData.tags);
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      const published = await withPetitionTransport((transport) => publishPetitionSignature({
        payload,
        creatorPubkeyHex: bytesToHex(
          Buffer.from(ownerPubkey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
        ),
        fragment: petition.fragment,
        relays,
        petitionTags: siteData.tags,
        secret: options.secret,
        signer,
        powDifficulty: Number.parseInt(options.powDifficulty, 10),
        transport,
      }));

      printOutput(published, Boolean(options.json));
    } finally {
      await closeSignerQuietly(signer);
    }
  });

petition
  .command('count')
  .description('Count signatures for a petition by its derived d-tag.')
  .argument('<petition>', 'Petition fragment or full petition URL.')
  .option('--password <password>', 'Decrypt the petition first using this password.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (petitionInput, options) => {
    const petition = await resolveRuntimeSiteInput(petitionInput, 'petition', options.password);
    const siteData = petition.siteData;
    const relays = getRelayList(options.relay) ?? getPetitionRelays(siteData.tags);

    printOutput(
      await withPetitionTransport((transport) => countPetitionSignatures({
        fragment: petition.fragment,
        relays,
        transport,
      })),
      Boolean(options.json),
    );
  });

petition
  .command('signatures')
  .description('Fetch and decrypt petition signatures using the owner secret or active signer.')
  .argument('<petition>', 'Petition fragment or full petition URL.')
  .option('--secret <secret>', 'Petition owner nsec or 64-char hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the petition first using this password.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--pow-difficulty <bits>', 'Override the proof-of-work difficulty.', '20')
  .option('--csv', 'Emit CSV output.')
  .option('--json', 'Emit JSON output.')
  .action(async (petitionInput, options) => {
    const petition = await resolveRuntimeSiteInput(petitionInput, 'petition', options.password);
    const siteData = petition.siteData;
    const relays = getRelayList(options.relay) ?? getPetitionRelays(siteData.tags);
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      const fetched = await withPetitionTransport((transport) => fetchPetitionSignaturesForOwner({
        fragment: petition.fragment,
        ownerSecret: options.secret,
        ownerSigner: signer,
        relays,
        powDifficulty: Number.parseInt(options.powDifficulty, 10),
        transport,
      }));

      if (options.csv) {
        printTextOutput(formatPetitionSignaturesCsv(fetched));
        return;
      }

      printOutput(fetched, Boolean(options.json));
    } finally {
      await closeSignerQuietly(signer);
    }
  });

const fundraiser = program.command('fundraiser').description('Inspect fundraiser donation methods and Lightning invoice flows.');
const fundraiserDonate = fundraiser.command('donate').description('List methods or generate a fundraiser Lightning invoice.');
const message = program.command('message').description('Inspect message tip methods and Lightning invoice flows.');
const messageTip = message.command('tip').description('List methods or generate a message Lightning invoice.');

fundraiserDonate
  .command('methods')
  .description('List the fundraiser donation methods encoded in tag l.')
  .argument('<fundraiser>', 'Fundraiser fragment or full fundraiser URL.')
  .option('--password <password>', 'Decrypt the fundraiser first using this password.')
  .option('--json', 'Emit JSON output.')
  .action(async (fundraiserInput, options) => {
    const fundraiser = await resolveRuntimeSiteInput(fundraiserInput, 'fundraiser', options.password);
    printOutput(
      {
        methods: await listFundraiserDonationMethods(fundraiser.url),
      },
      Boolean(options.json),
    );
  });

fundraiserDonate
  .command('invoice')
  .description('Generate a Lightning invoice for a fundraiser donation.')
  .argument('<fundraiser>', 'Fundraiser fragment or full fundraiser URL.')
  .option('--method <id>', 'Donation method id. Defaults to "lightning".', 'lightning')
  .requiredOption('--sats <count>', 'Donation amount in sats.')
  .option('--password <password>', 'Decrypt the fundraiser first using this password.')
  .option('--json', 'Emit JSON output.')
  .action(async (fundraiserInput, options) => {
    const fundraiser = await resolveRuntimeSiteInput(fundraiserInput, 'fundraiser', options.password);
    printOutput(
      await createFundraiserDonationInvoice({
        fundraiserInput: fundraiser.url,
        methodId: options.method,
        sats: Number.parseInt(options.sats, 10),
      }),
      Boolean(options.json),
    );
  });

messageTip
  .command('methods')
  .description('List the message tip methods encoded in tag l.')
  .argument('<message>', 'Message fragment or full message URL.')
  .option('--password <password>', 'Decrypt the message first using this password.')
  .option('--json', 'Emit JSON output.')
  .action(async (messageInput, options) => {
    const message = await resolveRuntimeSiteInput(messageInput, 'message', options.password);
    printOutput(
      {
        methods: await listMessageTipMethods(message.url),
      },
      Boolean(options.json),
    );
  });

messageTip
  .command('invoice')
  .description('Generate a Lightning invoice for a message tip.')
  .argument('<message>', 'Message fragment or full message URL.')
  .option('--method <id>', 'Tip method id. Defaults to "lightning".', 'lightning')
  .requiredOption('--sats <count>', 'Tip amount in sats.')
  .option('--password <password>', 'Decrypt the message first using this password.')
  .option('--json', 'Emit JSON output.')
  .action(async (messageInput, options) => {
    const message = await resolveRuntimeSiteInput(messageInput, 'message', options.password);
    printOutput(
      await createMessageTipInvoice({
        messageInput: message.url,
        methodId: options.method,
        sats: Number.parseInt(options.sats, 10),
      }),
      Boolean(options.json),
    );
  });

const forum = program.command('forum').description('Manage forum relay flows.');
const forumWot = forum.command('wot').description('Inspect forum web-of-trust gates.');

forumWot
  .command('check')
  .description('Check whether an author is allowed by the forum WoT settings for a given scope.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--scope <scope>', 'Moderation scope: post, reply, chat, or torrent.')
  .requiredOption('--author <pubkey>', 'Author pubkey as hex or npub.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--profile-relay <url>', 'Profile relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    printOutput(
      await withForumPoolCleanup(() => checkForumWotAccess({
        forumInput: forum.url,
        scope: options.scope,
        author: options.author,
        profileRelays: getRelayList(options.profileRelay),
      })),
      Boolean(options.json),
    );
  });

forum
  .command('post')
  .description('Publish a forum post.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--input <path>', 'Path to the post JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON forum post payload.');
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await withForumPoolCleanup(() => publishForumPostFromInput({
          forumInput: forum.url,
          topic: readString(payload, 'topic', false),
          title: readString(payload, 'title') as string,
          body: readString(payload, 'body', false),
          link: readString(payload, 'link', false),
          secret: options.secret,
          signer,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

forum
  .command('posts')
  .description('List forum posts, optionally scoped to a topic.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .option('--topic <topic>', 'Only list posts for this topic.')
  .option('--moderated', 'Filter out entries blocked by forum WoT or banned-word rules.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--profile-relay <url>', 'Profile relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const posts = await withForumPoolCleanup(() => listForumPosts({
      forumInput: forum.url,
      topic: options.topic,
      salt: options.salt,
      relays: getRelayList(options.relay),
    }));
    printOutput(
      {
        posts: options.moderated
          ? await withForumPoolCleanup(() => filterModeratedEntries({
            forumInput: forum.url,
            scope: 'post',
            entries: posts,
            profileRelays: getRelayList(options.profileRelay),
            getAuthor: (entry) => entry.payload.p,
            getText: (entry) => [entry.payload.t, entry.payload.b, entry.payload.l].filter(Boolean).join('\n'),
          }))
          : posts,
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
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON forum reply payload.');
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await withForumPoolCleanup(() => publishForumReplyFromInput({
          forumInput: forum.url,
          postEventId: options.postEvent,
          body: readString(payload, 'body') as string,
          quotedReplyId: readString(payload, 'quotedReplyId', false),
          secret: options.secret,
          signer,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

forum
  .command('replies')
  .description('List replies for a forum post.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--post-event <id>', 'Target post event id.')
  .option('--moderated', 'Filter out replies blocked by forum WoT or banned-word rules.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--profile-relay <url>', 'Profile relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const replies = await withForumPoolCleanup(() => listForumReplies({
      forumInput: forum.url,
      postEventId: options.postEvent,
      salt: options.salt,
      relays: getRelayList(options.relay),
    }));
    printOutput(
      {
        replies: options.moderated
          ? await withForumPoolCleanup(() => filterModeratedEntries({
            forumInput: forum.url,
            scope: 'reply',
            entries: replies,
            profileRelays: getRelayList(options.profileRelay),
            getAuthor: (entry) => entry.payload.p,
            getText: (entry) => entry.payload.b,
          }))
          : replies,
      },
      Boolean(options.json),
    );
  });

const forumTorrent = forum.command('torrent').description('Publish or inspect forum torrent entries.');

forumTorrent
  .command('parse')
  .description('Parse a .torrent file into the torrent payload fields that Nowhere stores.')
  .argument('<file>', 'Path to the .torrent file.')
  .option('--json', 'Emit JSON output.')
  .action(async (file, options) => {
    printOutput(parseTorrentFile(await readFile(file)), Boolean(options.json));
  });

forumTorrent
  .command('check')
  .description('Validate a torrent submission against forum settings and detect duplicates before publish.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--torrent-file <path>', 'Path to the .torrent file.')
  .requiredOption('--category <path>', 'Torrent category path, such as "docs > manuals".')
  .option('--title <title>', 'Override the parsed torrent title.')
  .option('--description <text>', 'Optional torrent description.')
  .option('--tracker <url>', 'Override trackers. Repeat to pass more than one tracker.', collectOption, [])
  .option('--ref <value>', 'Optional DB reference. Repeat to pass more than one reference.', collectOption, [])
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const torrent = await buildTorrentFromFileOptions({
      torrentFile: options.torrentFile,
      category: options.category,
      title: options.title,
      description: options.description,
      tracker: options.tracker,
      ref: options.ref,
    });
    printOutput(
      await withForumPoolCleanup(() => checkForumTorrentSubmission({
        forumInput: forum.url,
        torrent,
        salt: options.salt,
        relays: getRelayList(options.relay),
      })),
      Boolean(options.json),
    );
  });

forumTorrent
  .command('publish')
  .description('Publish a forum torrent payload.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .option('--input <path>', 'Path to the torrent JSON, or "-" for stdin.')
  .option('--torrent-file <path>', 'Path to the .torrent file.')
  .option('--category <path>', 'Torrent category path when using --torrent-file.')
  .option('--title <title>', 'Override the parsed torrent title when using --torrent-file.')
  .option('--description <text>', 'Optional torrent description when using --torrent-file.')
  .option('--tracker <url>', 'Override trackers when using --torrent-file. Repeat for more.', collectOption, [])
  .option('--ref <value>', 'Optional DB reference when using --torrent-file. Repeat for more.', collectOption, [])
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const torrent = await resolveTorrentSubmission(options);
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await withForumPoolCleanup(() => publishForumTorrentFromInput({
          forumInput: forum.url,
          secret: options.secret,
          signer,
          salt: options.salt,
          relays: getRelayList(options.relay),
          torrent,
        })),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

forumTorrent
  .command('reply')
  .description('Publish a reply to an existing forum torrent entry.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--torrent-event <id>', 'Target torrent event id.')
  .requiredOption('--input <path>', 'Path to the torrent reply JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON torrent reply payload.');
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await withForumPoolCleanup(() => publishForumTorrentReplyFromInput({
          forumInput: forum.url,
          torrentEventId: options.torrentEvent,
          body: readString(payload, 'body') as string,
          quotedReplyId: readString(payload, 'quotedReplyId', false),
          secret: options.secret,
          signer,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

forumTorrent
  .command('replies')
  .description('List replies for a forum torrent entry.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--torrent-event <id>', 'Target torrent event id.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    printOutput(
      {
        replies: await withForumPoolCleanup(() => listForumTorrentReplies({
          forumInput: forum.url,
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
  .option('--moderated', 'Filter out torrents blocked by forum WoT or banned-word rules.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--profile-relay <url>', 'Profile relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const torrents = await withForumPoolCleanup(() => listForumTorrents({
      forumInput: forum.url,
      salt: options.salt,
      relays: getRelayList(options.relay),
    }));
    printOutput(
      {
        torrents: options.moderated
          ? await withForumPoolCleanup(() => filterModeratedEntries({
            forumInput: forum.url,
            scope: 'torrent',
            entries: torrents,
            profileRelays: getRelayList(options.profileRelay),
            getAuthor: (entry) => entry.authorPubkey,
            getText: (entry) => entry.torrentData.title,
          }))
          : torrents,
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
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--session-secret <secret>', 'Optional stable session secret to advertise for private chat.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON chat payload.');
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await withForumPoolCleanup(() => publishGeneralChatMessage({
          forumInput: forum.url,
          message: readString(payload, 'message') as string,
          secret: options.secret,
          signer,
          sessionSecret: options.sessionSecret,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

const forumPrivate = forum.command('private').description('Publish or inspect private forum chat messages.');

forumPrivate
  .command('send')
  .description('Publish an encrypted private forum message to a session pubkey.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--recipient-session-pubkey <pubkey>', 'Recipient stable session pubkey (hex).')
  .requiredOption('--input <path>', 'Path to the private chat JSON, or "-" for stdin.')
  .option('--secret <secret>', 'Optional signer nsec or 64-char hex secret.')
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON private chat payload.');
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await withForumPoolCleanup(() => publishPrivateChatMessage({
          forumInput: forum.url,
          recipientSessionPubkey: options.recipientSessionPubkey,
          message: readString(payload, 'message') as string,
          secret: options.secret,
          signer,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

forumPrivate
  .command('list')
  .description('List encrypted private forum messages for the active forum session.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .option('--session-secret <secret>', 'Override the persisted forum session secret used to decrypt incoming private messages.')
  .option('--peer-pubkey <pubkey>', 'Only include messages from this author pubkey.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    printOutput(
      {
        messages: await withForumPoolCleanup(() => listPrivateChatMessages({
          forumInput: forum.url,
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
  .option('--moderated', 'Filter out chat messages blocked by forum WoT or banned-word rules.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--profile-relay <url>', 'Profile relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const messages = await withForumPoolCleanup(() => listGeneralChatMessages({
      forumInput: forum.url,
      salt: options.salt,
      relays: getRelayList(options.relay),
    }));
    printOutput(
      {
        messages: options.moderated
          ? await withForumPoolCleanup(() => filterModeratedEntries({
            forumInput: forum.url,
            scope: 'chat',
            entries: messages,
            profileRelays: getRelayList(options.profileRelay),
            getAuthor: (entry) => entry.payload.p,
            getText: (entry) => entry.payload.b,
          }))
          : messages,
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
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON room announcement payload.');
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await withForumPoolCleanup(() => publishRoomAnnouncement({
          forumInput: forum.url,
          roomName: readString(payload, 'roomName') as string,
          accessCode: readString(payload, 'accessCode') as string,
          secret: options.secret,
          signer,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

forumRoom
  .command('announcements')
  .description('List room announcements visible to the forum key.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    printOutput(
      {
        announcements: await withForumPoolCleanup(() => listRoomAnnouncements({
          forumInput: forum.url,
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
  .option('--use-signer', 'Use the persisted remote signer instead of a local secret.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const payload = await readObjectInput(options.input, 'Expected a JSON room chat payload.');
    const signer = await resolveOptionalSigner(options.secret, options.useSigner);
    try {
      printOutput(
        await withForumPoolCleanup(() => publishRoomChatMessage({
          forumInput: forum.url,
          roomName: readString(payload, 'roomName') as string,
          accessCode: readString(payload, 'accessCode') as string,
          message: readString(payload, 'message') as string,
          secret: options.secret,
          signer,
          salt: options.salt,
          relays: getRelayList(options.relay),
        })),
        Boolean(options.json),
      );
    } finally {
      await closeSignerQuietly(signer);
    }
  });

forumRoom
  .command('list')
  .description('List encrypted forum room messages.')
  .argument('<forum>', 'Forum fragment or full forum URL.')
  .requiredOption('--room-name <name>', 'Room name.')
  .requiredOption('--access-code <code>', 'Room access code.')
  .option('--moderated', 'Filter out room chat messages blocked by forum WoT or banned-word rules.')
  .option('--password <password>', 'Decrypt the forum first using this password.')
  .option('--profile-relay <url>', 'Profile relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--salt <salt>', 'Optional salt appended to the forum fragment before key derivation.')
  .option('--relay <url>', 'Relay override. Repeat to pass more than one relay.', collectOption, [])
  .option('--json', 'Emit JSON output.')
  .action(async (forumInput, options) => {
    const forum = await resolveRuntimeSiteInput(forumInput, 'discussion', options.password);
    const messages = await withForumPoolCleanup(() => listRoomChatMessages({
      forumInput: forum.url,
      roomName: options.roomName,
      accessCode: options.accessCode,
      salt: options.salt,
      relays: getRelayList(options.relay),
    }));
    printOutput(
      {
        messages: options.moderated
          ? await withForumPoolCleanup(() => filterModeratedEntries({
            forumInput: forum.url,
            scope: 'chat',
            entries: messages,
            profileRelays: getRelayList(options.profileRelay),
            getAuthor: (entry) => entry.payload.p,
            getText: (entry) => entry.payload.b,
          }))
          : messages,
      },
      Boolean(options.json),
    );
  });

program.parseAsync(normalizeLeadingDashPositionalArg(program, process.argv)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
