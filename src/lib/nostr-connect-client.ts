import { hexToBytes } from '@noble/hashes/utils.js';
import { decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';
import type { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

const NOSTR_CONNECT_KIND = 24133;

interface PendingRequest {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface ResponseBody {
  id?: string;
  result?: string;
  error?: string;
}

interface IncomingEvent {
  pubkey: string;
  content: string;
}

interface SubCloser {
  close: () => void;
}

function isNip04Ciphertext(ciphertext: string): boolean {
  const length = ciphertext.length;
  if (length < 28) {
    return false;
  }

  return (
    ciphertext[length - 28] === '?'
    && ciphertext[length - 27] === 'i'
    && ciphertext[length - 26] === 'v'
    && ciphertext[length - 25] === '='
  );
}

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }

  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

export interface NostrConnectClientOptions {
  pool: SimplePool;
  relays: string[];
  clientSecretHex: string;
  remotePubkey?: string;
  secret?: string;
  onAuthUrl?: (url: string) => void;
}

export class NostrConnectClient {
  private readonly pool: SimplePool;
  private readonly relays: string[];
  private readonly secretKey: Uint8Array;
  private readonly clientPubkey: string;
  private readonly secret?: string;
  private readonly onAuthUrl?: (url: string) => void;

  private remotePubkey?: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly authRequests = new Set<string>();
  private subCloser?: SubCloser;
  private closed = false;
  private waitingForSigner: PendingRequest | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: NostrConnectClientOptions) {
    this.pool = options.pool;
    this.relays = options.relays;
    this.secretKey = hexToBytes(options.clientSecretHex);
    this.clientPubkey = getPublicKey(this.secretKey);
    this.remotePubkey = options.remotePubkey;
    this.secret = options.secret;
    this.onAuthUrl = options.onAuthUrl;
  }

  open(): void {
    if (this.subCloser || this.closed) {
      return;
    }

    this.openSubscription();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.subCloser) {
      try {
        this.subCloser.close();
      } catch {
        // Swallow subscription close failures.
      }
      this.subCloser = undefined;
    }
    if (this.waitingForSigner) {
      this.waitingForSigner.reject(new Error('Closed'));
      this.waitingForSigner = null;
    }
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Closed'));
    }
    this.pending.clear();
  }

  async connect(perms?: string): Promise<string> {
    if (!this.remotePubkey) {
      throw new Error('Cannot connect without a remote signer pubkey.');
    }

    return this.sendRequest('connect', [this.remotePubkey, this.secret ?? '', perms ?? '']);
  }

  async getPublicKey(): Promise<string> {
    return this.sendRequest('get_public_key', []);
  }

  async signEvent(template: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<{
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  }> {
    const result = await this.sendRequest('sign_event', [JSON.stringify(template)]);
    return JSON.parse(result);
  }

  async nip44Encrypt(thirdPartyPubkey: string, plaintext: string): Promise<string> {
    return this.sendRequest('nip44_encrypt', [thirdPartyPubkey, plaintext]);
  }

  async nip44Decrypt(thirdPartyPubkey: string, ciphertext: string): Promise<string> {
    return this.sendRequest('nip44_decrypt', [thirdPartyPubkey, ciphertext]);
  }

  async waitForSigner(abortSignal?: AbortSignal): Promise<string> {
    if (this.remotePubkey) {
      return this.remotePubkey;
    }

    this.open();
    return new Promise<string>((resolve, reject) => {
      this.waitingForSigner = {
        resolve: () => resolve(this.remotePubkey as string),
        reject,
      };
      abortSignal?.addEventListener(
        'abort',
        () => {
          this.waitingForSigner?.reject(new Error('Aborted'));
          this.waitingForSigner = null;
          this.close();
        },
        { once: true },
      );
    });
  }

  private openSubscription(): void {
    if (this.closed) {
      return;
    }

    try {
      const subscription = this.pool.subscribe(
        this.relays,
        { kinds: [NOSTR_CONNECT_KIND], '#p': [this.clientPubkey] },
        {
          onevent: (event: IncomingEvent) => void this.handleEvent(event),
          onclose: () => {
            this.subCloser = undefined;
            if (!this.closed) {
              if (this.retryTimer) {
                clearTimeout(this.retryTimer);
              }
              this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.openSubscription();
              }, 1000);
            }
          },
        },
      );
      this.subCloser = subscription as unknown as SubCloser;
    } catch {
      if (!this.closed) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.openSubscription();
        }, 1000);
      }
    }
  }

  private async handleEvent(event: IncomingEvent): Promise<void> {
    if (this.remotePubkey && event.pubkey !== this.remotePubkey) {
      return;
    }

    let plaintext: string;
    try {
      if (isNip04Ciphertext(event.content)) {
        plaintext = await nip04Decrypt(this.secretKey, event.pubkey, event.content);
      } else {
        plaintext = nip44Decrypt(event.content, getConversationKey(this.secretKey, event.pubkey));
      }
    } catch {
      return;
    }

    let response: ResponseBody;
    try {
      response = JSON.parse(plaintext) as ResponseBody;
    } catch {
      return;
    }

    if (
      !this.remotePubkey
      && (response.result === 'ack' || (this.secret && response.result === this.secret))
    ) {
      this.remotePubkey = event.pubkey;
      this.waitingForSigner?.resolve('connected');
      this.waitingForSigner = null;
      return;
    }

    if (!response.id) {
      return;
    }

    if (response.result === 'auth_url' && response.error) {
      if (!this.authRequests.has(response.id)) {
        this.authRequests.add(response.id);
        this.onAuthUrl?.(response.error);
      }
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error));
      return;
    }

    pending.resolve(response.result ?? '');
  }

  private async sendRequest(method: string, params: string[]): Promise<string> {
    if (!this.remotePubkey) {
      throw new Error('No remote signer pubkey set.');
    }

    this.open();
    const id = generateRequestId();
    const body = { id, method, params };
    const encrypted = nip44Encrypt(
      JSON.stringify(body),
      getConversationKey(this.secretKey, this.remotePubkey),
    );
    const event = finalizeEvent(
      {
        kind: NOSTR_CONNECT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', this.remotePubkey]],
        content: encrypted,
      },
      this.secretKey,
    );

    const responsePromise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.pool.publish(this.relays, event);
    return responsePromise;
  }
}
