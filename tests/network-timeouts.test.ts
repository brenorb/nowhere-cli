import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startMockRelay } from './support/mockRelay.js';
import { createServer } from 'node:http';
import type { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchWithTimeout, setRequestTimeoutMs } from '../src/lib/network.js';
import { connectSignerViaBunker } from '../src/lib/active-signer.js';
import { NostrConnectClient } from '../src/lib/nostr-connect-client.js';

afterEach(() => { setRequestTimeoutMs(15_000); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  test('CLI closes relay resources after a signer request times out', async () => {
    const relay = await startMockRelay();
    try {
      const uri = `bunker://${getPublicKey(Buffer.from('2'.repeat(64), 'hex'))}?relay=${encodeURIComponent(relay.url)}`;
      await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--request-timeout', '0.05', 'signer', 'connect', '--bunker', uri], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 2000,
      })).rejects.toMatchObject({ code: 1, killed: false, stderr: expect.stringContaining('Remote signer did not respond') });
    } finally { await relay.close(); }
  });

  test('signer name resolution uses the same bounded fetch and preserves request options', async () => {
    const implementation = vi.fn(async (_url: unknown, init: RequestInit = {}) => {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', implementation);
    await expect(connectSignerViaBunker('alice@example.com')).rejects.toThrow('Could not parse bunker input');
    expect(implementation).toHaveBeenCalledOnce();
  });

});
