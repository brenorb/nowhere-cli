import { createServer } from 'node:http';
import type { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchWithTimeout, setRequestTimeoutMs } from '../src/lib/network.js';
import { NostrConnectClient } from '../src/lib/nostr-connect-client.js';

afterEach(() => { setRequestTimeoutMs(15_000); vi.restoreAllMocks(); });

describe('bounded network operations', () => {
  test('HTTP timeout covers a response that sends headers but never finishes its body', async () => {
    const server = createServer((_request, response) => { response.writeHead(200); response.write('{'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    setRequestTimeoutMs(30);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      await expect(fetchWithTimeout(`http://127.0.0.1:${address.port}`).then((response) => response.json())).rejects.toThrow();
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  test('a silent remote signer times out and removes pending work', async () => {
    const pool = { subscribe: vi.fn(() => ({ close() {} })), publish: vi.fn(() => [Promise.resolve('ok')]) } as unknown as SimplePool;
    const client = new NostrConnectClient({ pool, relays: [], clientSecretHex: '1'.repeat(64), remotePubkey: getPublicKey(Buffer.from('2'.repeat(64), 'hex')) });
    setRequestTimeoutMs(20);
    try { await expect(client.getPublicKey()).rejects.toThrow('Remote signer did not respond'); } finally { client.close(); }
  });
});
