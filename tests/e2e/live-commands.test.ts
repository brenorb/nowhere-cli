import { describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { finalizeEvent } from 'nostr-tools/pure';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import { startMockRelay } from '../support/mockRelay.js';
import { publishToRelays, destroyPool } from '../../src/lib/relay.js';

const execFileAsync = promisify(execFile);
const cwd = '/Users/breno/Documents/code/PROJECTS/HRF_GRANT/nowhere-cli';

async function cli(...args: string[]) {
  const result = await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], { cwd });
  return JSON.parse(result.stdout);
}

async function cliWithEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], {
    cwd,
    env: { ...process.env, ...env },
  });
  return JSON.parse(result.stdout);
}

async function cliText(...args: string[]) {
  const result = await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], { cwd });
  return result.stdout.trim();
}

async function cliFailure(...args: string[]) {
  try {
    await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], { cwd });
    throw new Error('Expected the CLI command to fail.');
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
    return stderr;
  }
}

async function withJsonFile(payload: unknown, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nowhere-cli-live-'));
  const file = join(dir, 'input.json');
  await writeFile(file, JSON.stringify(payload, null, 2));
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withBinaryFile(name: string, bytes: Uint8Array, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nowhere-cli-live-'));
  const file = join(dir, name);
  await writeFile(file, bytes);
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempDir(prefix: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeTorrentBytes(): Uint8Array {
  const torrent = [
    'd',
    '8:announce',
    '28:udp://tracker.example.com:80',
    '13:announce-list',
    'll28:udp://tracker.example.com:80e',
    'l27:https://tracker.example.comee',
    '4:info',
    'd',
    '6:length',
    'i1024e',
    '4:name',
    '7:Archive',
    '12:piece length',
    'i16384e',
    '6:pieces',
    '20:12345678901234567890',
    'e',
    'e',
  ].join('');
  return new TextEncoder().encode(torrent);
}

describe('relay-backed CLI commands', () => {
  test('forum moderation commands expose WOT access checks and moderated post listings', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const trusted = generateSecretMaterial();
    const outsider = generateSecretMaterial();

    try {
      const followEvent = finalizeEvent({
        kind: 3,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [['p', trusted.pubkeyHex]],
      }, owner.secretKey);
      await publishToRelays(followEvent, [relay.url]);

      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Moderated Forum',
          tags: [
            { key: '1', value: relay.url },
            { key: '2', value: relay.url },
            { key: 'W', value: '1' },
            { key: 'X', value: 'blocked' },
          ],
        },
        async (forumPath) => {
          const forum = await cli('create', 'forum', '--input', forumPath, '--json');

          await withJsonFile(
            { title: 'Trusted post', body: 'clean text' },
            async (trustedPostPath) => {
              await cli(
                'forum',
                'post',
                forum.fragment,
                '--input',
                trustedPostPath,
                '--secret',
                trusted.secretHex,
                '--relay',
                relay.url,
                '--json',
              );
            },
          );

          await withJsonFile(
            { title: 'Outsider blocked', body: 'blocked phrase' },
            async (outsiderPostPath) => {
              await cli(
                'forum',
                'post',
                forum.fragment,
                '--input',
                outsiderPostPath,
                '--secret',
                outsider.secretHex,
                '--relay',
                relay.url,
                '--json',
              );
            },
          );

          const moderated = await cli(
            'forum',
            'posts',
            forum.fragment,
            '--moderated',
            '--profile-relay',
            relay.url,
            '--relay',
            relay.url,
            '--json',
          );

          expect(moderated.posts).toHaveLength(1);
          expect(moderated.posts[0]?.payload.t).toBe('Trusted post');

          const access = await cli(
            'forum',
            'wot',
            'check',
            forum.fragment,
            '--scope',
            'post',
            '--author',
            outsider.pubkeyHex,
            '--profile-relay',
            relay.url,
            '--json',
          );

          expect(access.allowed).toBe(false);
          expect(access.depth).toBe(1);
        },
      );
    } finally {
      destroyPool();
      await relay.close();
    }
  });

  test('store commands publish orders, decrypt receipts, and manage status', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const seller = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: seller.npub,
          name: 'Freedom Market',
          items: [{ name: 'Zine', price: 12, tags: [{ key: 'f', value: null }, { key: 'v', value: 'Small.Large' }] }],
          tags: [
            { key: '1', value: relay.url },
            { key: '2', value: relay.url },
            { key: '$', value: 'USD' },
            { key: 'k', value: null },
            { key: 's', value: '300' },
            { key: 'N', value: null },
            { key: 'A', value: null },
            { key: 'L', value: 'US' },
            { key: 'R', value: 'CA700' },
            { key: 'l', value: 'tips@seller.test' },
            { key: 'j', value: 'seller@payid.test' },
            { key: '5', value: '*USD:Wire:acct-123' },
          ],
        },
        async (storePath) => {
          const store = await cli('create', 'store', '--input', storePath, '--json');

          await withJsonFile(
            {
              buyer: { name: 'Alex', email: 'alex@example.com' },
              items: [{ i: 0, qty: 2 }],
              subtotal: 24,
              shipping: 3,
              total: 27,
              paymentMethod: 'btc',
              paymentCurrency: 'BTC',
              paymentAmount: 0.00027,
            },
            async (orderPath) => {
              const published = await cli(
                'store',
                'order',
                store.fragment,
                '--input',
                orderPath,
                '--relay',
                relay.url,
                '--json',
              );

              expect(published.order.orderId).toMatch(/^[0-9a-f]{15}$/);

              await withJsonFile(published.receiptPayload, async (receiptPath) => {
                const receipt = await cli(
                  'store',
                  'receipt',
                  'decrypt',
                  '--input',
                  receiptPath,
                  '--secret',
                  seller.nsec,
                  '--json',
                );

                expect(receipt.order.orderId).toBe(published.order.orderId);
                expect(receipt.order.buyer.name).toBe('Alex');

                const verified = await cli(
                  'store',
                  'verify',
                  store.fragment,
                  '--input',
                  receiptPath,
                  '--secret',
                  seller.nsec,
                  '--received-sats',
                  '27000',
                  '--store-sats-per-unit',
                  '1000',
                  '--json',
                );

                expect(verified.ok).toBe(true);
                expect(verified.verification.expectedShipping).toBe(3);
                expect(verified.verification.expectedTotal).toBe(27);
                expect(verified.verification.expectedSats).toBe(27000);
              });

              await withJsonFile(
                {
                  buyer: { name: 'Blake', email: 'blake@example.com' },
                  items: [{ i: 0, qty: 1 }],
                  subtotal: 12,
                  shipping: 3,
                  total: 15,
                  paymentMethod: 'btc',
                  paymentCurrency: 'BTC',
                  paymentAmount: 0.00015,
                },
                async (secondOrderPath) => {
                  await cli(
                    'store',
                    'order',
                    store.fragment,
                    '--input',
                    secondOrderPath,
                    '--relay',
                    relay.url,
                    '--json',
                  );
                },
              );

              const fetchedOrders = await cli(
                'store',
                'orders',
                store.fragment,
                '--secret',
                seller.secretHex,
                '--relay',
                relay.url,
                '--json',
              );

              expect(fetchedOrders.orders).toHaveLength(2);
              expect(fetchedOrders.orders.some((entry: { order: { total: number } }) => entry.order.total === 2700)).toBe(true);

              const csv = await cliText(
                'store',
                'orders',
                store.fragment,
                '--secret',
                seller.secretHex,
                '--relay',
                relay.url,
                '--csv',
              );

              expect(csv).toContain('Date,Order ID,Store');
              expect(csv).toContain(published.order.orderId);
              expect(csv).toContain('Freedom Market');
              expect(csv).toContain('Alex');

              const fetchedById = await cli(
                'store',
                'orders',
                store.fragment,
                '--secret',
                seller.secretHex,
                '--order-id',
                published.order.orderId,
                '--relay',
                relay.url,
                '--json',
              );

              expect(fetchedById.orders).toHaveLength(1);
              expect(fetchedById.orders[0]?.order.orderId).toBe(published.order.orderId);
            },
          );

          await withJsonFile(
            {
              v: 1,
              notice: 'One size delayed',
              items: { '0': 2 },
              low: { warn: true, fields: 'email', refund: false },
            },
            async (statusPath) => {
              const publishedStatus = await cli(
                'store',
                'status',
                'publish',
                store.fragment,
                '--input',
                statusPath,
                '--secret',
                seller.nsec,
                '--relay',
                relay.url,
                '--json',
              );

              expect(publishedStatus.payload.notice).toBe('One size delayed');

              const fetchedStatus = await cli(
                'store',
                'status',
                'fetch',
                store.fragment,
                '--relay',
                relay.url,
                '--json',
              );

              expect(fetchedStatus.payload.notice).toBe('One size delayed');
              expect(fetchedStatus.payload.items['0']).toBe(2);
            },
          );

          await withJsonFile(
            {
              items: [{ i: 0, qty: 1, v: 'Small' }],
            },
            async (cartPath) => {
              const quoted = await cli(
                'store',
                'checkout',
                'quote',
                store.fragment,
                '--cart',
                cartPath,
                '--buyer-country',
                'CA',
                '--json',
              );

              expect(quoted.total).toBe(19);
              expect(quoted.inventory.gate).toBe('ok');
              expect(quoted.fields.required).toEqual(expect.arrayContaining([
                'name',
                'email',
                'street',
                'city',
                'country',
              ]));
              expect(quoted.methods.map((entry: { method: { id: string } }) => entry.method.id)).toEqual([
                'bitcoin',
                'payid',
                'custom_0',
              ]);

              await withJsonFile(
                {
                  name: 'Alex',
                  email: 'alex@example.com',
                  street: '1 Relay Way',
                  city: 'Toronto',
                  country: 'CA',
                },
                async (buyerPath) => {
                  const started = await cli(
                    'store',
                    'checkout',
                    'begin',
                    store.fragment,
                    '--cart',
                    cartPath,
                    '--buyer',
                    buyerPath,
                    '--method',
                    'payid',
                    '--json',
                  );

                  expect(started.flow).toBe('manual');
                  expect(started.paymentCurrency).toBe('AUD');
                  expect(started.instructions).toContain('seller@payid.test');
                  expect(started.published.order.paymentMethod).toBe('payid');
                },
              );
            },
          );
        },
      );
    } finally {
      await relay.close();
    }
  });

  test('petition commands sign, count, and decrypt signatures', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const signer = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Keep the Channel Open',
          tags: [
            { key: 'N', value: null },
            { key: 'E', value: null },
            { key: 'R', value: null },
            { key: 'c', value: 'BR.US' },
            { key: '1', value: relay.url },
          ],
        },
        async (petitionPath) => {
          const petition = await cli('create', 'petition', '--input', petitionPath, '--json');

          await withJsonFile(
            {
              email: 'casey@example.com',
              country: 'CA',
            },
            async (invalidSignaturePath) => {
              const stderr = await cliFailure(
                'petition',
                'sign',
                petition.fragment,
                '--input',
                invalidSignaturePath,
                '--secret',
                signer.nsec,
                '--relay',
                relay.url,
                '--pow-difficulty',
                '8',
                '--json',
              );

              expect(stderr).toMatch(/name is required/i);
            },
          );

          await withJsonFile(
            {
              ts: Date.now(),
              name: 'Casey',
              email: 'casey@example.com',
              country: 'US',
              comment: 'Solidarity.',
            },
            async (signaturePath) => {
              const signed = await cli(
                'petition',
                'sign',
                petition.fragment,
                '--input',
                signaturePath,
                '--secret',
                signer.nsec,
                '--relay',
                relay.url,
                '--pow-difficulty',
                '8',
                '--json',
              );

              expect(signed.anonymous).toBe(false);

              const counted = await cli(
                'petition',
                'count',
                petition.fragment,
                '--relay',
                relay.url,
                '--json',
              );

              expect(counted.count).toBe(1);

              const fetched = await cli(
                'petition',
                'signatures',
                petition.fragment,
                '--secret',
                owner.secretHex,
                '--relay',
                relay.url,
                '--pow-difficulty',
                '8',
                '--json',
              );

              expect(fetched.signatures).toHaveLength(1);
              expect(fetched.signatures[0]?.payload.name).toBe('Casey');
              expect(fetched.signatures[0]?.payload.comment).toBe('Solidarity.');

              const csv = await cliText(
                'petition',
                'signatures',
                petition.fragment,
                '--secret',
                owner.secretHex,
                '--relay',
                relay.url,
                '--pow-difficulty',
                '8',
                '--csv',
              );

              expect(csv).toContain('"Signed At","Name","Email"');
              expect(csv).toContain('"Casey"');
              expect(csv).toContain('"Solidarity."');
            },
          );
        },
      );
    } finally {
      await relay.close();
    }
  });

  test('fundraiser commands list donation methods', async () => {
    await withJsonFile(
      {
        name: 'Freedom Fund',
        tags: [
          { key: 'l', value: 'tips@seller.test,*PayPal:paypal.me/freedom,*!BTC:bc1qfundraiser' },
        ],
      },
      async (fundraiserPath) => {
        const fundraiser = await cli('create', 'fundraiser', '--input', fundraiserPath, '--json');
        const methods = await cli(
          'fundraiser',
          'donate',
          'methods',
          fundraiser.fragment,
          '--json',
        );

        expect(methods.methods).toHaveLength(3);
        expect(methods.methods[0]?.id).toBe('lightning');
        expect(methods.methods[1]?.id).toBe('custom_0');
        expect(methods.methods[2]?.showQr).toBe(true);
      },
    );
  });

  test('message commands list tip methods', async () => {
    await withJsonFile(
      {
        name: 'Signal Boost',
        description: 'Support the courier.',
        tags: [
          { key: 'l', value: 'tips@seller.test,*PayPal:paypal.me/message,*!BTC:bc1qmessage' },
        ],
      },
      async (messagePath) => {
        const message = await cli('create', 'message', '--input', messagePath, '--json');
        const methods = await cli(
          'message',
          'tip',
          'methods',
          message.fragment,
          '--json',
        );

        expect(methods.methods).toHaveLength(3);
        expect(methods.methods[0]?.id).toBe('lightning');
        expect(methods.methods[1]?.id).toBe('custom_0');
        expect(methods.methods[2]?.showQr).toBe(true);
      },
    );
  });

  test('encrypted runtime commands accept passwords across store, petition, fundraiser, message, and forum', { timeout: 90000 }, async () => {
    const relay = await startMockRelay();
    const storeOwner = generateSecretMaterial();
    const petitionOwner = generateSecretMaterial();
    const petitionSigner = generateSecretMaterial();
    const forumOwner = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: storeOwner.npub,
          name: 'Encrypted Store',
          items: [{ name: 'Manual', price: 12, tags: [{ key: 'f', value: null }] }],
          tags: [
            { key: '1', value: relay.url },
            { key: '2', value: relay.url },
            { key: '$', value: 'USD' },
            { key: 'k', value: null },
            { key: 'l', value: 'tips@seller.test' },
          ],
        },
        async (storePath) => {
          const store = await cli(
            'create',
            'store',
            '--input',
            storePath,
            '--sign-secret',
            storeOwner.nsec,
            '--encrypt-password',
            'store-pass',
            '--json',
          );

          await withJsonFile(
            {
              buyer: { name: 'Avery' },
              items: [{ i: 0, qty: 1 }],
              subtotal: 12,
              shipping: 0,
              total: 12,
            },
            async (orderPath) => {
              const published = await cli(
                'store',
                'order',
                store.fragment,
                '--password',
                'store-pass',
                '--input',
                orderPath,
                '--relay',
                relay.url,
                '--json',
              );

              expect(published.order.total).toBe(1200);
            },
          );

          const fetched = await cli(
            'store',
            'orders',
            store.fragment,
            '--password',
            'store-pass',
            '--secret',
            storeOwner.secretHex,
            '--relay',
            relay.url,
            '--json',
          );

          expect(fetched.orders).toHaveLength(1);
          expect(fetched.orders[0]?.order.buyer.name).toBe('Avery');

          await withJsonFile(
            {
              v: 1,
              notice: 'Inventory live',
              items: { '0': 3 },
            },
            async (statusPath) => {
              await cli(
                'store',
                'status',
                'publish',
                store.fragment,
                '--password',
                'store-pass',
                '--input',
                statusPath,
                '--secret',
                storeOwner.nsec,
                '--relay',
                relay.url,
                '--json',
              );
            },
          );

          const status = await cli(
            'store',
            'status',
            'fetch',
            store.fragment,
            '--password',
            'store-pass',
            '--relay',
            relay.url,
            '--json',
          );

          expect(status.payload.notice).toBe('Inventory live');

          await withJsonFile(
            {
              items: [{ i: 0, qty: 1 }],
            },
            async (cartPath) => {
              const quote = await cli(
                'store',
                'checkout',
                'quote',
                store.fragment,
                '--password',
                'store-pass',
                '--cart',
                cartPath,
                '--relay',
                relay.url,
                '--json',
              );

              expect(quote.total).toBe(12);
              expect(quote.inventory.gate).toBe('ok');
            },
          );
        },
      );

      await withJsonFile(
        {
          pubkey: petitionOwner.npub,
          name: 'Encrypted Petition',
          tags: [
            { key: 'N', value: null },
            { key: '1', value: relay.url },
          ],
        },
        async (petitionPath) => {
          const petition = await cli(
            'create',
            'petition',
            '--input',
            petitionPath,
            '--sign-secret',
            petitionOwner.nsec,
            '--encrypt-password',
            'petition-pass',
            '--json',
          );

          await withJsonFile(
            {
              ts: Date.now(),
              name: 'Casey',
            },
            async (signaturePath) => {
              await cli(
                'petition',
                'sign',
                petition.fragment,
                '--password',
                'petition-pass',
                '--input',
                signaturePath,
                '--secret',
                petitionSigner.nsec,
                '--relay',
                relay.url,
                '--pow-difficulty',
                '4',
                '--json',
              );
            },
          );

          const count = await cli(
            'petition',
            'count',
            petition.fragment,
            '--password',
            'petition-pass',
            '--relay',
            relay.url,
            '--json',
          );

          expect(count.count).toBe(1);

          const signatures = await cli(
            'petition',
            'signatures',
            petition.fragment,
            '--password',
            'petition-pass',
            '--secret',
            petitionOwner.secretHex,
            '--relay',
            relay.url,
            '--pow-difficulty',
            '4',
            '--json',
          );

          expect(signatures.signatures).toHaveLength(1);
          expect(signatures.signatures[0]?.payload.name).toBe('Casey');
        },
      );

      await withJsonFile(
        {
          name: 'Encrypted Fund',
          tags: [
            { key: 'l', value: 'tips@seller.test,*PayPal:paypal.me/encrypted' },
          ],
        },
        async (fundraiserPath) => {
          const fundraiser = await cli(
            'create',
            'fundraiser',
            '--input',
            fundraiserPath,
            '--encrypt-password',
            'fund-pass',
            '--json',
          );

          const methods = await cli(
            'fundraiser',
            'donate',
            'methods',
            fundraiser.fragment,
            '--password',
            'fund-pass',
            '--json',
          );

          expect(methods.methods).toHaveLength(2);
          expect(methods.methods[0]?.id).toBe('lightning');
        },
      );

      await withJsonFile(
        {
          name: 'Encrypted Message',
          description: 'Private tip jar.',
          tags: [
            { key: 'l', value: 'tips@seller.test,*PayPal:paypal.me/private-tip' },
          ],
        },
        async (messagePath) => {
          const message = await cli(
            'create',
            'message',
            '--input',
            messagePath,
            '--encrypt-password',
            'message-pass',
            '--json',
          );

          const methods = await cli(
            'message',
            'tip',
            'methods',
            message.fragment,
            '--password',
            'message-pass',
            '--json',
          );

          expect(methods.methods).toHaveLength(2);
          expect(methods.methods[0]?.id).toBe('lightning');
        },
      );

      await withJsonFile(
        {
          pubkey: forumOwner.npub,
          name: 'Encrypted Forum',
          tags: [
            { key: '1', value: relay.url },
            { key: 'W', value: '0' },
          ],
        },
        async (forumPath) => {
          const forum = await cli(
            'create',
            'forum',
            '--input',
            forumPath,
            '--sign-secret',
            forumOwner.nsec,
            '--encrypt-password',
            'forum-pass',
            '--json',
          );

          await withJsonFile(
            {
              title: 'Encrypted thread',
              body: 'Need-to-know only',
            },
            async (postPath) => {
              await cli(
                'forum',
                'post',
                forum.fragment,
                '--password',
                'forum-pass',
                '--input',
                postPath,
                '--secret',
                forumOwner.nsec,
                '--relay',
                relay.url,
                '--json',
              );
            },
          );

          const posts = await cli(
            'forum',
            'posts',
            forum.fragment,
            '--password',
            'forum-pass',
            '--relay',
            relay.url,
            '--json',
          );

          expect(posts.posts).toHaveLength(1);
          expect(posts.posts[0]?.payload.t).toBe('Encrypted thread');

          const access = await cli(
            'forum',
            'wot',
            'check',
            forum.fragment,
            '--password',
            'forum-pass',
            '--scope',
            'post',
            '--author',
            forumOwner.pubkeyHex,
            '--json',
          );

          expect(access.allowed).toBe(true);
          expect(access.depth).toBe(0);
        },
      );
    } finally {
      destroyPool();
      await relay.close();
    }
  });

  test('forum commands publish posts, replies, torrents, room flows, and chat', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const session = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Field Forum',
          description: 'Private coordination',
          tags: [
            { key: 'i', value: '1' },
            { key: 'H', value: '0' },
            { key: 'V', value: null },
            { key: 'b', value: null },
            { key: '1', value: relay.url },
            { key: 'O', value: 'Ops\\pLogistics' },
            { key: 'q', value: 'Docs|Audio' },
            { key: 'F', value: null },
            { key: 'h', value: 'No malware. No dox.' },
          ],
        },
        async (forumPath) => {
          const forum = await cli('create', 'forum', '--input', forumPath, '--json');

          await withJsonFile(
            {
              topic: 'Ops',
              title: 'Checkpoint',
              body: 'Meet at 20:00 UTC',
            },
            async (postPath) => {
              const post = await cli(
                'forum',
                'post',
                forum.fragment,
                '--input',
                postPath,
                '--secret',
                owner.nsec,
                '--relay',
                relay.url,
                '--json',
              );

              const posts = await cli(
                'forum',
                'posts',
                forum.fragment,
                '--topic',
                'Ops',
                '--relay',
                relay.url,
                '--json',
              );

              expect(posts.posts).toHaveLength(1);
              expect(posts.posts[0]?.payload.t).toBe('Checkpoint');

              await withJsonFile(
                {
                  title: 'Salted checkpoint',
                  body: 'Fallback route only',
                },
                async (saltedPostPath) => {
                  await cli(
                    'forum',
                    'post',
                    forum.fragment,
                    '--input',
                    saltedPostPath,
                    '--secret',
                    owner.nsec,
                    '--salt',
                    'rotation-1',
                    '--relay',
                    relay.url,
                    '--json',
                  );

                  const saltedPosts = await cli(
                    'forum',
                    'posts',
                    forum.fragment,
                    '--salt',
                    'rotation-1',
                    '--relay',
                    relay.url,
                    '--json',
                  );

                  expect(saltedPosts.posts).toHaveLength(1);
                  expect(saltedPosts.posts[0]?.payload.t).toBe('Salted checkpoint');
                },
              );

              await withJsonFile(
                { body: 'Confirmed' },
                async (replyPath) => {
                  const reply = await cli(
                    'forum',
                    'reply',
                    forum.fragment,
                    '--post-event',
                    post.event.id,
                    '--input',
                    replyPath,
                    '--secret',
                    owner.secretHex,
                    '--relay',
                    relay.url,
                    '--json',
                  );

                  expect(reply.postTag).toBe(post.postTag);

                  const replies = await cli(
                    'forum',
                    'replies',
                    forum.fragment,
                    '--post-event',
                    post.event.id,
                    '--relay',
                    relay.url,
                    '--json',
                  );

                  expect(replies.replies).toHaveLength(1);
                  expect(replies.replies[0]?.payload.b).toBe('Confirmed');
                },
              );
            },
          );

          await withBinaryFile('archive.torrent', makeTorrentBytes(), async (torrentFilePath) => {
            const parsed = await cli(
              'forum',
              'torrent',
              'parse',
              torrentFilePath,
              '--json',
            );

            expect(parsed.infohash).toMatch(/^[0-9a-f]{40}$/);
            expect(parsed.title).toBe('Archive');
            expect(parsed.trackers).toEqual([
              'udp://tracker.example.com:80',
              'https://tracker.example.com',
            ]);

            const checkedBeforePublish = await cli(
              'forum',
              'torrent',
              'check',
              forum.fragment,
              '--torrent-file',
              torrentFilePath,
              '--category',
              'Docs > Manuals',
              '--description',
              'Encrypted media',
              '--ref',
              'ref:1',
              '--ref',
              'ref:1',
              '--relay',
              relay.url,
              '--json',
            );

            expect(checkedBeforePublish.duplicate).toBeNull();
            expect(checkedBeforePublish.torrent.category).toBe('docs > manuals');
            expect(checkedBeforePublish.settings.rules).toContain('No malware');

            const torrent = await cli(
              'forum',
              'torrent',
              'publish',
              forum.fragment,
              '--torrent-file',
              torrentFilePath,
              '--category',
              'Docs > Manuals',
              '--description',
              'Encrypted media',
              '--ref',
              'ref:1',
              '--secret',
              owner.nsec,
              '--relay',
              relay.url,
              '--json',
            );

            expect(torrent.postTag).toHaveLength(32);

            const checkedAfterPublish = await cli(
              'forum',
              'torrent',
              'check',
              forum.fragment,
              '--torrent-file',
              torrentFilePath,
              '--category',
              'Docs > Manuals',
              '--relay',
              relay.url,
              '--json',
            );

            expect(checkedAfterPublish.duplicate?.reason).toBe('infohash');

            const torrents = await cli(
              'forum',
              'torrents',
              forum.fragment,
              '--relay',
              relay.url,
              '--json',
            );

            expect(torrents.torrents).toHaveLength(1);
            expect(torrents.torrents[0]?.torrentData.title).toBe('Archive');
            expect(torrents.torrents[0]?.torrentData.category).toBe('docs > manuals');
            expect(torrents.torrents[0]?.magnetLink).toContain('magnet:?xt=urn:btih:');

            await withJsonFile(
              { body: 'Seeding confirmed' },
              async (torrentReplyPath) => {
                const reply = await cli(
                  'forum',
                  'torrent',
                  'reply',
                  forum.fragment,
                  '--torrent-event',
                  torrent.event.id,
                  '--input',
                  torrentReplyPath,
                  '--secret',
                  owner.nsec,
                  '--relay',
                  relay.url,
                  '--json',
                );

                expect(reply.postTag).toBe(torrent.postTag);

                const replies = await cli(
                  'forum',
                  'torrent',
                  'replies',
                  forum.fragment,
                  '--torrent-event',
                  torrent.event.id,
                  '--relay',
                  relay.url,
                  '--json',
                );

                expect(replies.replies).toHaveLength(1);
                expect(replies.replies[0]?.payload.b).toBe('Seeding confirmed');
              },
            );
          });

          await withJsonFile(
            {
              roomName: 'Logistics',
              accessCode: 'shared-secret',
            },
            async (announcementPath) => {
              const announced = await cli(
                'forum',
                'room',
                'announce',
                forum.fragment,
                '--input',
                announcementPath,
                '--secret',
                owner.nsec,
                '--relay',
                relay.url,
                '--json',
              );

              expect(announced.chatTag).toHaveLength(32);

              const announcements = await cli(
                'forum',
                'room',
                'announcements',
                forum.fragment,
                '--relay',
                relay.url,
                '--json',
              );

              expect(announcements.announcements).toHaveLength(1);
              expect(announcements.announcements[0]?.roomName).toBe('Logistics');
            },
          );

          await withJsonFile(
            {
              roomName: 'Logistics',
              accessCode: 'shared-secret',
              message: 'Meet at fallback point B',
            },
            async (roomChatPath) => {
              const sent = await cli(
                'forum',
                'room',
                'send',
                forum.fragment,
                '--input',
                roomChatPath,
                '--secret',
                owner.secretHex,
                '--relay',
                relay.url,
                '--json',
              );

              expect(sent.roomName).toBe('Logistics');

              const roomMessages = await cli(
                'forum',
                'room',
                'list',
                forum.fragment,
                '--room-name',
                'Logistics',
                '--access-code',
                'shared-secret',
                '--relay',
                relay.url,
                '--json',
              );

              expect(roomMessages.messages).toHaveLength(1);
              expect(roomMessages.messages[0]?.payload.b).toBe('Meet at fallback point B');
            },
          );

          await withJsonFile(
            { message: 'General chat online' },
            async (chatPath) => {
              const sent = await cli(
                'forum',
                'chat',
                'send',
                forum.fragment,
                '--input',
                chatPath,
                '--secret',
                owner.nsec,
                '--session-secret',
                session.secretHex,
                '--relay',
                relay.url,
                '--json',
              );

              expect(sent.chatTag).toHaveLength(32);

              const listed = await cli(
                'forum',
                'chat',
                'list',
                forum.fragment,
                '--relay',
                relay.url,
                '--json',
              );

              expect(listed.messages).toHaveLength(2);
              expect(listed.messages.some((message: { payload: { b: string } }) => message.payload.b === 'General chat online')).toBe(true);
              expect(listed.messages.some((message: { payload: { sp?: string } }) => message.payload.sp === session.pubkeyHex)).toBe(true);
              expect(
                listed.messages.some((message: { payload: { room?: { name: string } | string } }) =>
                  typeof message.payload.room === 'object' && message.payload.room?.name === 'Logistics'),
              ).toBe(true);
            },
          );

          await withJsonFile(
            { message: 'Encrypted side-channel' },
            async (privatePath) => {
              const sent = await cli(
                'forum',
                'private',
                'send',
                forum.fragment,
                '--recipient-session-pubkey',
                session.pubkeyHex,
                '--input',
                privatePath,
                '--secret',
                owner.secretHex,
                '--relay',
                relay.url,
                '--json',
              );

              expect(sent.recipientSessionPubkey).toBe(session.pubkeyHex);

              const listed = await cli(
                'forum',
                'private',
                'list',
                forum.fragment,
                '--session-secret',
                session.nsec,
                '--relay',
                relay.url,
                '--json',
              );

              expect(listed.messages).toHaveLength(1);
              expect(listed.messages[0]?.payload.b).toBe('Encrypted side-channel');
              expect(listed.messages[0]?.peerPubkey).toBe(owner.pubkeyHex);
            },
          );
        },
      );
    } finally {
      await relay.close();
    }
  });

  test('forum CLI reuses a persisted anonymous session for posts, chat routing, and private inbox decryption', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Anonymous Forum',
          description: 'CLI parity test',
          tags: [
            { key: 'i', value: '1' },
            { key: 'H', value: '0' },
            { key: 'V', value: null },
            { key: '1', value: relay.url },
          ],
        },
        async (forumPath) => {
          const forum = await cli('create', 'forum', '--input', forumPath, '--json');

          await withTempDir('nowhere-cli-session-', async (configHome) => {
            const env = { XDG_CONFIG_HOME: configHome };

            await withJsonFile(
              { title: 'Anonymous checkpoint', body: 'No signer provided' },
              async (postPath) => {
                const post = await cliWithEnv(
                  env,
                  'forum',
                  'post',
                  forum.fragment,
                  '--input',
                  postPath,
                  '--relay',
                  relay.url,
                  '--json',
                );

                await withJsonFile(
                  { message: 'Anonymous chat online' },
                  async (chatPath) => {
                    await cliWithEnv(
                      env,
                      'forum',
                      'chat',
                      'send',
                      forum.fragment,
                      '--input',
                      chatPath,
                      '--relay',
                      relay.url,
                      '--json',
                    );
                  },
                );

                const posts = await cliWithEnv(
                  env,
                  'forum',
                  'posts',
                  forum.fragment,
                  '--relay',
                  relay.url,
                  '--json',
                );
                expect(posts.posts).toHaveLength(1);
                expect(posts.posts[0]?.payload.p).toBe(post.authorPubkeyHex);

                const chat = await cliWithEnv(
                  env,
                  'forum',
                  'chat',
                  'list',
                  forum.fragment,
                  '--relay',
                  relay.url,
                  '--json',
                );
                const anonymousMessage = chat.messages.find((entry: { payload: { b: string } }) => entry.payload.b === 'Anonymous chat online');
                expect(anonymousMessage?.payload.p).toBe(post.authorPubkeyHex);
                expect(anonymousMessage?.payload.sp).toMatch(/^[0-9a-f]{64}$/);

                await withJsonFile(
                  { message: 'Private follow-up' },
                  async (privatePath) => {
                    await cli(
                      'forum',
                      'private',
                      'send',
                      forum.fragment,
                      '--recipient-session-pubkey',
                      anonymousMessage.payload.sp,
                      '--input',
                      privatePath,
                      '--secret',
                      owner.secretHex,
                      '--relay',
                      relay.url,
                      '--json',
                    );
                  },
                );

                const inbox = await cliWithEnv(
                  env,
                  'forum',
                  'private',
                  'list',
                  forum.fragment,
                  '--relay',
                  relay.url,
                  '--json',
                );
                expect(inbox.messages).toHaveLength(1);
                expect(inbox.messages[0]?.payload.b).toBe('Private follow-up');
                expect(inbox.messages[0]?.peerPubkey).toBe(owner.pubkeyHex);
              },
            );
          });
        },
      );
    } finally {
      destroyPool();
      await relay.close();
    }
  });
});
