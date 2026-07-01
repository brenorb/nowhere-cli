import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import { nip19 } from 'nostr-tools';
import { parseBunkerInput, type BunkerPointer } from 'nostr-tools/nip46';
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { parseSecretKeyInput } from './keys.js';
import { NostrConnectClient } from './nostr-connect-client.js';
import { getPool } from './relay.js';

const ACTIVE_SIGNER_FILE = 'active-signer.json';
const NOSTR_CONNECT_KIND = 24133;
const NOSTR_CONNECT_APP_NAME = 'Nowhere CLI';
const NOSTR_CONNECT_APP_PERMS = [
  'get_public_key',
  'sign_event:1',
  'sign_event:30078',
  'sign_event:21423',
  'sign_event:22242',
  'sign_event:21426',
  'nip44_encrypt',
  'nip44_decrypt',
];

export interface UnsignedSignerEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface SignedSignerEvent extends UnsignedSignerEvent {
  id: string;
  pubkey: string;
  sig: string;
}

export interface CliSigner {
  readonly type: 'local' | 'nip46';
  readonly pubkeyHex: string;
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedSignerEvent): Promise<SignedSignerEvent>;
  nip44Encrypt(thirdPartyPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(thirdPartyPubkey: string, ciphertext: string): Promise<string>;
  disconnect(): Promise<void>;
}

interface PersistedNip46Signer {
  type: 'nip46';
  pubkeyHex: string;
  bunkerUri: string;
  bunkerPubkey: string;
  clientSecretHex: string;
  relays: string[];
}

type PersistedSigner = PersistedNip46Signer;

class LocalSecretSigner implements CliSigner {
  readonly type = 'local' as const;
  readonly pubkeyHex: string;

  constructor(private readonly secretKey: Uint8Array) {
    this.pubkeyHex = getPublicKey(secretKey);
  }

  async getPublicKey(): Promise<string> {
    return this.pubkeyHex;
  }

  async signEvent(event: UnsignedSignerEvent): Promise<SignedSignerEvent> {
    return finalizeEvent(event, this.secretKey);
  }

  async nip44Encrypt(thirdPartyPubkey: string, plaintext: string): Promise<string> {
    return nip44Encrypt(plaintext, getConversationKey(this.secretKey, thirdPartyPubkey));
  }

  async nip44Decrypt(thirdPartyPubkey: string, ciphertext: string): Promise<string> {
    return nip44Decrypt(ciphertext, getConversationKey(this.secretKey, thirdPartyPubkey));
  }

  async disconnect(): Promise<void> {
    // No transport to tear down for local secrets.
  }
}

class Nip46Signer implements CliSigner {
  readonly type = 'nip46' as const;

  constructor(
    readonly pubkeyHex: string,
    private readonly client: NostrConnectClient,
    private readonly persisted: PersistedNip46Signer,
  ) {}

  async getPublicKey(): Promise<string> {
    return this.pubkeyHex;
  }

  async signEvent(event: UnsignedSignerEvent): Promise<SignedSignerEvent> {
    return this.client.signEvent(event);
  }

  async nip44Encrypt(thirdPartyPubkey: string, plaintext: string): Promise<string> {
    return this.client.nip44Encrypt(thirdPartyPubkey, plaintext);
  }

  async nip44Decrypt(thirdPartyPubkey: string, ciphertext: string): Promise<string> {
    return this.client.nip44Decrypt(thirdPartyPubkey, ciphertext);
  }

  async disconnect(): Promise<void> {
    this.client.close();
  }

  async persist(): Promise<void> {
    await writePersistedSigner(this.persisted);
  }
}

function signerConfigHome(): string {
  return process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
}

export function getActiveSignerPath(): string {
  return join(signerConfigHome(), 'nowhere-cli', ACTIVE_SIGNER_FILE);
}

function normalizeRelays(relays: string[]): string[] {
  return [...new Set(relays.map((relay) => relay.trim()).filter(Boolean))];
}

function randomSecret(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function buildNostrConnectUri(options: {
  clientPubkey: string;
  relays: string[];
  secret: string;
}): string {
  const params = new URLSearchParams();
  params.set('secret', options.secret);
  params.set('name', NOSTR_CONNECT_APP_NAME);
  params.set('perms', NOSTR_CONNECT_APP_PERMS.join(','));
  for (const relay of options.relays) {
    params.append('relay', relay);
  }
  return `nostrconnect://${options.clientPubkey}?${params.toString()}`;
}

function stripSecretParam(uri: string): string {
  try {
    const index = uri.indexOf('?');
    if (index < 0) {
      return uri;
    }

    const base = uri.slice(0, index);
    const params = new URLSearchParams(uri.slice(index + 1));
    params.delete('secret');
    const serialized = params.toString();
    return serialized ? `${base}?${serialized}` : base;
  } catch {
    return uri;
  }
}

async function readPersistedSigner(): Promise<PersistedSigner | null> {
  const path = getActiveSignerPath();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedNip46Signer>;
    if (
      parsed.type === 'nip46'
      && typeof parsed.pubkeyHex === 'string'
      && typeof parsed.bunkerUri === 'string'
      && typeof parsed.bunkerPubkey === 'string'
      && typeof parsed.clientSecretHex === 'string'
      && Array.isArray(parsed.relays)
    ) {
      return {
        type: 'nip46',
        pubkeyHex: parsed.pubkeyHex,
        bunkerUri: parsed.bunkerUri,
        bunkerPubkey: parsed.bunkerPubkey,
        clientSecretHex: parsed.clientSecretHex,
        relays: normalizeRelays(parsed.relays.map(String)),
      };
    }
    await clearPersistedSigner();
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    await clearPersistedSigner();
    return null;
  }
}

async function writePersistedSigner(signer: PersistedSigner): Promise<void> {
  const path = getActiveSignerPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(signer, null, 2)}\n`, 'utf8');
}

async function clearPersistedSigner(): Promise<void> {
  await rm(getActiveSignerPath(), { force: true });
}

function createNip46Signer(options: PersistedNip46Signer): Nip46Signer {
  const client = new NostrConnectClient({
    pool: getPool(),
    relays: options.relays,
    clientSecretHex: options.clientSecretHex,
    remotePubkey: options.bunkerPubkey,
  });
  client.open();
  return new Nip46Signer(options.pubkeyHex, client, options);
}

export function signerFromSecret(secret: string | Uint8Array): CliSigner {
  return new LocalSecretSigner(typeof secret === 'string' ? parseSecretKeyInput(secret) : secret);
}

export async function restoreActiveSigner(): Promise<CliSigner | null> {
  const persisted = await readPersistedSigner();
  if (!persisted) {
    return null;
  }

  try {
    return createNip46Signer(persisted);
  } catch {
    await clearPersistedSigner();
    return null;
  }
}

export async function requireActiveSigner(): Promise<CliSigner> {
  const signer = await restoreActiveSigner();
  if (!signer) {
    throw new Error('No active remote signer. Run `nowhere signer connect --bunker <uri>` first.');
  }
  return signer;
}

export async function connectSignerViaBunker(input: string): Promise<CliSigner> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Enter a bunker URL or name@domain.');
  }

  const bunkerPointer: BunkerPointer | null = await parseBunkerInput(trimmed);
  if (!bunkerPointer) {
    throw new Error('Could not parse bunker input. Expected bunker:// URL or name@domain.');
  }

  const clientSecret = generateSecretKey();
  const clientSecretHex = bytesToHex(clientSecret);
  const relays = normalizeRelays(bunkerPointer.relays);
  if (relays.length === 0) {
    throw new Error('The bunker input did not provide any relays.');
  }

  const client = new NostrConnectClient({
    pool: getPool(),
    relays,
    clientSecretHex,
    remotePubkey: bunkerPointer.pubkey,
    secret: bunkerPointer.secret ?? undefined,
  });
  client.open();
  await client.connect(NOSTR_CONNECT_APP_PERMS.join(','));
  const pubkeyHex = await client.getPublicKey();
  const signer = new Nip46Signer(pubkeyHex, client, {
    type: 'nip46',
    pubkeyHex,
    bunkerUri: stripSecretParam(trimmed),
    bunkerPubkey: bunkerPointer.pubkey,
    clientSecretHex,
    relays,
  });
  await signer.persist();
  return signer;
}

export async function disconnectActiveSigner(): Promise<{ connected: boolean; pubkeyHex: string | null; type: 'nip46' | null }> {
  const persisted = await readPersistedSigner();
  const pubkeyHex = persisted?.pubkeyHex ?? null;
  const type = persisted?.type ?? null;
  await clearPersistedSigner();
  return {
    connected: false,
    pubkeyHex,
    type,
  };
}

export async function getActiveSignerStatus(): Promise<{
  connected: boolean;
  type: 'nip46' | null;
  pubkeyHex: string | null;
  npub: string | null;
  path: string;
}> {
  const persisted = await readPersistedSigner();
  const pubkeyHex = persisted?.pubkeyHex ?? null;
  const npub = pubkeyHex ? nip19.npubEncode(pubkeyHex) : null;
  return {
    connected: Boolean(pubkeyHex),
    type: persisted?.type ?? null,
    pubkeyHex,
    npub,
    path: getActiveSignerPath(),
  };
}

export function buildNostrConnectHandshake(relays: string[]): { uri: string; clientSecretHex: string } {
  const clientSecret = generateSecretKey();
  const clientSecretHex = bytesToHex(clientSecret);
  return {
    uri: buildNostrConnectUri({
      clientPubkey: getPublicKey(clientSecret),
      relays: normalizeRelays(relays),
      secret: randomSecret(),
    }),
    clientSecretHex,
  };
}
