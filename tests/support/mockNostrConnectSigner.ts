import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { type Event, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from 'nostr-tools/nip44';

const NOSTR_CONNECT_KIND = 24133;

interface NostrConnectRequest {
  id: string;
  method: string;
  params: string[];
}

interface MockNostrConnectSignerOptions {
  relayUrl: string;
  authUrl?: string;
}

export interface MockNostrConnectSignerHandle {
  bunkerUri: string;
  pubkeyHex: string;
  npub: string;
  authorizeUri: (uri: string) => Promise<void>;
  close: () => Promise<void>;
}

function buildResponse(request: NostrConnectRequest, signerSecret: Uint8Array): string {
  switch (request.method) {
    case 'connect':
      return JSON.stringify({ id: request.id, result: 'ack' });
    case 'get_public_key':
      return JSON.stringify({ id: request.id, result: getPublicKey(signerSecret) });
    case 'sign_event': {
      const [templateJson] = request.params;
      const template = JSON.parse(templateJson ?? '{}') as {
        kind: number;
        created_at: number;
        tags: string[][];
        content: string;
      };
      return JSON.stringify({ id: request.id, result: JSON.stringify(finalizeEvent(template, signerSecret)) });
    }
    case 'nip44_encrypt': {
      const [thirdPartyPubkey, plaintext] = request.params;
      return JSON.stringify({
        id: request.id,
        result: nip44Encrypt(plaintext ?? '', getConversationKey(signerSecret, thirdPartyPubkey ?? '')),
      });
    }
    case 'nip44_decrypt': {
      const [thirdPartyPubkey, ciphertext] = request.params;
      return JSON.stringify({
        id: request.id,
        result: nip44Decrypt(ciphertext ?? '', getConversationKey(signerSecret, thirdPartyPubkey ?? '')),
      });
    }
    default:
      return JSON.stringify({ id: request.id, error: `Unsupported method: ${request.method}` });
  }
}

export async function startMockNostrConnectSigner(
  options: MockNostrConnectSignerOptions,
): Promise<MockNostrConnectSignerHandle> {
  const signerSecret = generateSecretKey();
  const pubkeyHex = getPublicKey(signerSecret);
  const pool = new SimplePool();
  const subscription = pool.subscribe(
    [options.relayUrl],
    { kinds: [NOSTR_CONNECT_KIND], '#p': [pubkeyHex] },
    {
      onevent: async (event: Event) => {
        try {
          const requestJson = nip44Decrypt(event.content, getConversationKey(signerSecret, event.pubkey));
          const request = JSON.parse(requestJson) as NostrConnectRequest;
          if (request.method === 'connect' && options.authUrl) {
            const authEvent = finalizeEvent(
              {
                kind: NOSTR_CONNECT_KIND,
                created_at: Math.floor(Date.now() / 1000),
                tags: [['p', event.pubkey]],
                content: nip44Encrypt(
                  JSON.stringify({ id: request.id, result: 'auth_url', error: options.authUrl }),
                  getConversationKey(signerSecret, event.pubkey),
                ),
              },
              signerSecret,
            );
            await Promise.allSettled(pool.publish([options.relayUrl], authEvent));
          }
          const responseEvent = finalizeEvent(
            {
              kind: NOSTR_CONNECT_KIND,
              created_at: Math.floor(Date.now() / 1000),
              tags: [['p', event.pubkey]],
              content: nip44Encrypt(buildResponse(request, signerSecret), getConversationKey(signerSecret, event.pubkey)),
            },
            signerSecret,
          );
          await Promise.allSettled(pool.publish([options.relayUrl], responseEvent));
        } catch {
          // Ignore malformed test traffic.
        }
      },
    },
  );

  const relayParam = encodeURIComponent(options.relayUrl);
  return {
    bunkerUri: `bunker://${pubkeyHex}?relay=${relayParam}`,
    pubkeyHex,
    npub: nip19.npubEncode(pubkeyHex),
    authorizeUri: async (uri: string) => {
      const parsed = new URL(uri);
      const clientPubkey = parsed.hostname || parsed.pathname.replace(/^\//, '');
      const secret = parsed.searchParams.get('secret');
      if (!clientPubkey || !secret) {
        throw new Error('Invalid nostrconnect URI for mock authorization.');
      }

      const ackEvent = finalizeEvent(
        {
          kind: NOSTR_CONNECT_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', clientPubkey]],
          content: nip44Encrypt(JSON.stringify({ result: secret }), getConversationKey(signerSecret, clientPubkey)),
        },
        signerSecret,
      );
      await Promise.allSettled(pool.publish([options.relayUrl], ackEvent));
    },
    close: async () => {
      subscription.close();
      pool.destroy();
    },
  };
}
