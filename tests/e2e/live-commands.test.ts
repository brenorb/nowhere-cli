import { describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { encryptFragment } from '@nowhere/codec';
import { finalizeEvent } from 'nostr-tools/pure';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import { startMockRelay } from '../support/mockRelay.js';
import { publishToRelays, destroyPool } from '../../src/lib/relay.js';
import { startMockNostrConnectSigner } from '../support/mockNostrConnectSigner.js';

const execFileAsync = promisify(execFile);
const cwd = '/Users/REDACTED';
const cliArgs = ['--import', 'tsx', 'src/cli.ts'];

async function cli(...args: string[]) {
  const result = await execFileAsync('node', [...cliArgs, ...args], { cwd });
  return JSON.parse(result.stdout);
}

async function cliWithEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = await execFileAsync('node', [...cliArgs, ...args], {
    cwd,
    env: { ...process.env, ...env },
  });
  return JSON.parse(result.stdout);
}

async function cliTextWithEnv(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = await execFileAsync('node', [...cliArgs, ...args], {
    cwd,
    env: { ...process.env, ...env },
  });
  return result.stdout.trim();
}

async function cliText(...args: string[]) {
  const result = await execFileAsync('node', [...cliArgs, ...args], { cwd });
  return result.stdout.trim();
}

async function cliFailure(...args: string[]) {
  try {
    await execFileAsync('node', [...cliArgs, ...args], { cwd });
    throw new Error('Expected the CLI command to fail.');
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
    return stderr;
  }
}

async function cliWatchLines(afterStart: () => Promise<void>, ...args: string[]) {
  const watch = execFileAsync('node', [...cliArgs, ...args], { cwd });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await afterStart();
  const result = await watch;
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

async function withTextFile(name: string, text: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nowhere-cli-live-'));
  const file = join(dir, name);
  await writeFile(file, text, 'utf8');
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

  test('forum torrent replies support the same moderation filter as post replies', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const outsider = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Moderated Torrent Forum',
          tags: [
            { key: '1', value: relay.url },
            { key: 'X', value: 'blocked' },
            { key: 'b', value: null },
          ],
        },
        async (forumPath) => {
          const forum = await cli('create', 'forum', '--input', forumPath, '--json');

          await withBinaryFile('archive.torrent', makeTorrentBytes(), async (torrentFilePath) => {
            const torrent = await cli(
              'forum',
              'torrent',
              'publish',
              forum.fragment,
              '--torrent-file',
              torrentFilePath,
              '--category',
              'Docs > Manuals',
              '--secret',
              owner.nsec,
              '--relay',
              relay.url,
              '--json',
            );

            await withJsonFile(
              { body: 'clean seeding update' },
              async (cleanReplyPath) => {
                await cli(
                  'forum',
                  'torrent',
                  'reply',
                  forum.fragment,
                  '--torrent-event',
                  torrent.event.id,
                  '--input',
                  cleanReplyPath,
                  '--secret',
                  owner.nsec,
                  '--relay',
                  relay.url,
                  '--json',
                );
              },
            );

            await withJsonFile(
              { body: 'blocked mirror online' },
              async (blockedReplyPath) => {
                await cli(
                  'forum',
                  'torrent',
                  'reply',
                  forum.fragment,
                  '--torrent-event',
                  torrent.event.id,
                  '--input',
                  blockedReplyPath,
                  '--secret',
                  outsider.nsec,
                  '--relay',
                  relay.url,
                  '--json',
                );
              },
            );

            const allReplies = await cli(
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
            expect(allReplies.replies).toHaveLength(2);

            const moderatedReplies = await cli(
              'forum',
              'torrent',
              'replies',
              forum.fragment,
              '--torrent-event',
              torrent.event.id,
              '--moderated',
              '--relay',
              relay.url,
              '--json',
            );

            expect(moderatedReplies.replies).toHaveLength(1);
            expect(moderatedReplies.replies[0]?.payload.b).toBe('clean seeding update');
          });
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

  test('store manage commands persist local bookkeeping for confirmations, hiding, notes, and reconciliation', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const seller = generateSecretMaterial();

    try {
      await withTempDir('nowhere-cli-manage-', async (configHome) => {
        const env = { XDG_CONFIG_HOME: configHome };

        await withJsonFile(
          {
            pubkey: seller.npub,
            name: 'Managed Store',
            items: [{ name: 'Notebook', price: 12 }],
            tags: [
              { key: '1', value: relay.url },
              { key: '2', value: relay.url },
              { key: '$', value: 'USD' },
            ],
          },
          async (storePath) => {
            const store = await cli('create', 'store', '--input', storePath, '--json');

            const publishOrder = async (buyerName: string) => {
              let published: any;
              await withJsonFile(
                {
                  buyer: { name: buyerName },
                  items: [{ i: 0, qty: 1 }],
                  subtotal: 12,
                  shipping: 0,
                  total: 12,
                },
                async (orderPath) => {
                  published = await cli(
                    'store',
                    'order',
                    store.fragment,
                    '--input',
                    orderPath,
                    '--relay',
                    relay.url,
                    '--json',
                  );
                },
              );
              return published;
            };

            const first = await publishOrder('Alice');
            const second = await publishOrder('Bob');

            await cliWithEnv(
              env,
              'store',
              'manage',
              'confirm',
              store.fragment,
              '--order-id',
              first.order.orderId,
              '--json',
            );
            await cliWithEnv(
              env,
              'store',
              'manage',
              'note',
              store.fragment,
              '--order-id',
              first.order.orderId,
              '--note',
              'Paid via bank wire.',
              '--json',
            );
            await cliWithEnv(
              env,
              'store',
              'manage',
              'hide',
              store.fragment,
              '--order-id',
              second.order.orderId,
              '--json',
            );
            await cliWithEnv(
              env,
              'store',
              'manage',
              'status',
              store.fragment,
              '--order-id',
              first.order.orderId,
              '--status',
              'fulfilled',
              '--json',
            );

            await withTextFile(
              'reconcile.txt',
              `${first.order.orderId}\ndeadbeefdeadbee\n`,
              async (reconcilePath) => {
                const reconciled = await cliWithEnv(
                  env,
                  'store',
                  'manage',
                  'reconcile',
                  store.fragment,
                  '--input',
                  reconcilePath,
                  '--secret',
                  seller.secretHex,
                  '--relay',
                  relay.url,
                  '--json',
                );
                expect(reconciled.matched).toContain(first.order.orderId);
                expect(reconciled.missing).toContain('deadbeefdeadbee');
              },
            );

            const state = await cliWithEnv(env, 'store', 'manage', 'state', store.fragment, '--json');
            expect(state.state.confirmedOrderIds).toContain(first.order.orderId);
            expect(state.state.hiddenOrderIds).toContain(second.order.orderId);
            expect(state.state.orderStatuses[first.order.orderId]).toBe('fulfilled');
            expect(state.state.orderNotes[first.order.orderId]).toBe('Paid via bank wire.');

            const orders = await cliWithEnv(
              env,
              'store',
              'orders',
              store.fragment,
              '--secret',
              seller.secretHex,
              '--relay',
              relay.url,
              '--json',
            );
            const managedFirst = orders.orders.find((entry: { order: { orderId: string } }) => entry.order.orderId === first.order.orderId);
            const managedSecond = orders.orders.find((entry: { order: { orderId: string } }) => entry.order.orderId === second.order.orderId);
            expect(managedFirst?.manage.confirmed).toBe(true);
            expect(managedFirst?.manage.status).toBe('fulfilled');
            expect(managedFirst?.manage.note).toBe('Paid via bank wire.');
            expect(managedSecond?.manage.hidden).toBe(true);

            const csv = await cliTextWithEnv(
              env,
              'store',
              'orders',
              store.fragment,
              '--secret',
              seller.secretHex,
              '--relay',
              relay.url,
              '--csv',
            );
            expect(csv).toContain('Status,Confirmed');
            expect(csv).toContain(`Managed Store,fulfilled,Yes,Alice`);

            await cliWithEnv(
              env,
              'store',
              'manage',
              'unhide',
              store.fragment,
              '--order-id',
              second.order.orderId,
              '--json',
            );
            await cliWithEnv(
              env,
              'store',
              'manage',
              'unconfirm',
              store.fragment,
              '--order-id',
              first.order.orderId,
              '--json',
            );

            const updatedState = await cliWithEnv(env, 'store', 'manage', 'state', store.fragment, '--json');
            expect(updatedState.state.confirmedOrderIds).not.toContain(first.order.orderId);
            expect(updatedState.state.hiddenOrderIds).not.toContain(second.order.orderId);
          },
        );
      });
    } finally {
      destroyPool();
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
          const unsignedStore = await cli(
            'create',
            'store',
            '--input',
            storePath,
            '--sign-secret',
            storeOwner.nsec,
            '--json',
          );
          const signedStoreFragment = unsignedStore.signedFragment ?? unsignedStore.fragment;
          let storePassword = 'store-pass';
          let encryptedStoreFragment = '';
          for (let index = 0; index < 512; index += 1) {
            const candidatePassword = `store-pass-${index}`;
            const candidateFragment = await encryptFragment(signedStoreFragment, candidatePassword);
            if (candidateFragment.startsWith('-')) {
              storePassword = candidatePassword;
              encryptedStoreFragment = candidateFragment;
              break;
            }
          }
          expect(encryptedStoreFragment.startsWith('-')).toBe(true);

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
                encryptedStoreFragment,
                '--password',
                storePassword,
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
            encryptedStoreFragment,
            '--password',
            storePassword,
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
                encryptedStoreFragment,
                '--password',
                storePassword,
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
            encryptedStoreFragment,
            '--password',
            storePassword,
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
                encryptedStoreFragment,
                '--password',
                storePassword,
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

  test('forum commands publish posts, replies, torrents, room flows, and chat', { timeout: 60000 }, async () => {
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

          await withJsonFile(
            { type: 'join', channel: 'general' },
            async (voicePath) => {
              const published = await cli(
                'forum',
                'voice',
                'send',
                forum.fragment,
                '--input',
                voicePath,
                '--secret',
                owner.nsec,
                '--session-secret',
                session.secretHex,
                '--relay',
                relay.url,
                '--json',
              );

              expect(published.payload.type).toBe('join');
              expect(published.event.created_at).toBe(published.payload.ts);

              const listed = await cli(
                'forum',
                'voice',
                'list',
                forum.fragment,
                '--channel',
                'general',
                '--relay',
                relay.url,
                '--json',
              );

              expect(listed.signals).toHaveLength(1);
              expect(listed.signals[0]?.payload.type).toBe('join');
              expect(listed.signals[0]?.joinSignatureValid).toBe(true);
            },
          );

          await withJsonFile(
            {
              type: 'mute',
              channel: 'room',
              roomName: 'Logistics',
              accessCode: 'shared-secret',
              muted: true,
            },
            async (roomVoicePath) => {
              await cli(
                'forum',
                'voice',
                'send',
                forum.fragment,
                '--input',
                roomVoicePath,
                '--secret',
                owner.nsec,
                '--session-secret',
                session.secretHex,
                '--relay',
                relay.url,
                '--json',
              );

              const listed = await cli(
                'forum',
                'voice',
                'list',
                forum.fragment,
                '--channel',
                'room',
                '--room-name',
                'Logistics',
                '--access-code',
                'shared-secret',
                '--relay',
                relay.url,
                '--json',
              );

              expect(listed.signals).toHaveLength(1);
              expect(listed.signals[0]?.payload.type).toBe('mute');
              expect(listed.signals[0]?.payload.muted).toBe(true);
            },
          );

          await withJsonFile(
            {
              type: 'offer',
              channel: 'private',
              peerPubkey: session.pubkeyHex,
              recipientSessionPubkey: session.pubkeyHex,
              target: session.pubkeyHex,
              sdp: 'offer-sdp',
            },
            async (privateVoicePath) => {
              await cli(
                'forum',
                'voice',
                'send',
                forum.fragment,
                '--input',
                privateVoicePath,
                '--secret',
                owner.nsec,
                '--session-secret',
                session.secretHex,
                '--relay',
                relay.url,
                '--json',
              );

              const listed = await cli(
                'forum',
                'voice',
                'list',
                forum.fragment,
                '--channel',
                'private',
                '--session-secret',
                session.nsec,
                '--relay',
                relay.url,
                '--json',
              );

              expect(listed.signals).toHaveLength(1);
              expect(listed.signals[0]?.payload.type).toBe('offer');
              expect(listed.signals[0]?.peerPubkey).toBe(owner.pubkeyHex);
            },
          );
        },
      );
    } finally {
      await relay.close();
    }
  });

  test('forum browse commands support search, filters, and alternate sort modes for posts and torrents', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const secondAuthor = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Browse Forum',
          description: 'Filtering coverage',
          tags: [
            { key: 'i', value: '1' },
            { key: 'V', value: null },
            { key: '1', value: relay.url },
            { key: 'O', value: 'Ops\\pLogistics' },
            { key: 'q', value: 'Docs|Audio' },
            { key: 'b', value: null },
            { key: 'F', value: null },
          ],
        },
        async (forumPath) => {
          const forum = await cli('create', 'forum', '--input', forumPath, '--json');

          let firstPostEventId = '';
          let imagePostEventId = '';

          await withJsonFile(
            { topic: 'Ops', title: 'Alpha note', body: 'First checkpoint details.' },
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
              firstPostEventId = post.event.id;
            },
          );

          await withJsonFile(
            { topic: 'Ops', title: 'Map image', link: 'https://cdn.example.com/map.png' },
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
              imagePostEventId = post.event.id;
            },
          );

          await withJsonFile(
            { body: 'First reply' },
            async (replyPath) => {
              await cli(
                'forum',
                'reply',
                forum.fragment,
                '--post-event',
                firstPostEventId,
                '--input',
                replyPath,
                '--secret',
                owner.nsec,
                '--relay',
                relay.url,
                '--json',
              );
            },
          );

          await withJsonFile(
            { body: 'Second reply' },
            async (replyPath) => {
              await cli(
                'forum',
                'reply',
                forum.fragment,
                '--post-event',
                firstPostEventId,
                '--input',
                replyPath,
                '--secret',
                secondAuthor.nsec,
                '--relay',
                relay.url,
                '--json',
              );
            },
          );

          const searchedPosts = await cli(
            'forum',
            'posts',
            forum.fragment,
            '--topic',
            'Ops',
            '--search',
            'map image',
            '--relay',
            relay.url,
            '--json',
          );
          expect(searchedPosts.posts).toHaveLength(1);
          expect(searchedPosts.posts[0]?.payload.t).toBe('Map image');

          const imagePosts = await cli(
            'forum',
            'posts',
            forum.fragment,
            '--topic',
            'Ops',
            '--type',
            'image',
            '--relay',
            relay.url,
            '--json',
          );
          expect(imagePosts.posts).toHaveLength(1);
          expect(imagePosts.posts[0]?.eventId).toBe(imagePostEventId);

          const oldestPosts = await cli(
            'forum',
            'posts',
            forum.fragment,
            '--topic',
            'Ops',
            '--sort',
            'oldest',
            '--relay',
            relay.url,
            '--json',
          );
          expect(oldestPosts.posts[0]?.eventId).toBe(firstPostEventId);

          const mostRepliedPosts = await cli(
            'forum',
            'posts',
            forum.fragment,
            '--topic',
            'Ops',
            '--sort',
            'replies',
            '--relay',
            relay.url,
            '--json',
          );
          expect(mostRepliedPosts.posts[0]?.eventId).toBe(firstPostEventId);

          await withJsonFile(
            {
              x: '1111111111111111111111111111111111111111',
              title: 'Archive Manual',
              description: 'Field guide bundle',
              files: [{ path: 'manual.pdf', size: 2048 }],
              trackers: ['https://tracker.example.com'],
              category: 'docs > manuals',
              refs: [],
            },
            async (torrentPath) => {
              await cli(
                'forum',
                'torrent',
                'publish',
                forum.fragment,
                '--input',
                torrentPath,
                '--secret',
                owner.nsec,
                '--relay',
                relay.url,
                '--json',
              );
            },
          );

          await withJsonFile(
            {
              x: '2222222222222222222222222222222222222222',
              title: 'Broadcast Audio',
              description: 'Interview segment',
              files: [{ path: 'audio.mp3', size: 1024 }],
              trackers: ['https://tracker.example.com'],
              category: 'audio > interviews',
              refs: [],
            },
            async (torrentPath) => {
              await cli(
                'forum',
                'torrent',
                'publish',
                forum.fragment,
                '--input',
                torrentPath,
                '--secret',
                secondAuthor.nsec,
                '--relay',
                relay.url,
                '--json',
              );
            },
          );

          const searchedTorrents = await cli(
            'forum',
            'torrents',
            forum.fragment,
            '--search',
            'broadcast',
            '--relay',
            relay.url,
            '--json',
          );
          expect(searchedTorrents.torrents).toHaveLength(1);
          expect(searchedTorrents.torrents[0]?.torrentData.title).toBe('Broadcast Audio');

          const categoryTorrents = await cli(
            'forum',
            'torrents',
            forum.fragment,
            '--category',
            'docs',
            '--relay',
            relay.url,
            '--json',
          );
          expect(categoryTorrents.torrents).toHaveLength(1);
          expect(categoryTorrents.torrents[0]?.torrentData.category).toBe('docs > manuals');

          const authorTorrents = await cli(
            'forum',
            'torrents',
            forum.fragment,
            '--author',
            secondAuthor.pubkeyHex,
            '--relay',
            relay.url,
            '--json',
          );
          expect(authorTorrents.torrents).toHaveLength(1);
          expect(authorTorrents.torrents[0]?.torrentData.title).toBe('Broadcast Audio');

          const sizedTorrents = await cli(
            'forum',
            'torrents',
            forum.fragment,
            '--sort',
            'size',
            '--order',
            'asc',
            '--relay',
            relay.url,
            '--json',
          );
          expect(sizedTorrents.torrents.map((entry: { torrentData: { title: string } }) => entry.torrentData.title)).toEqual([
            'Broadcast Audio',
            'Archive Manual',
          ]);
        },
      );
    } finally {
      destroyPool();
      await relay.close();
    }
  });

  test('forum watch mode streams newly discovered posts, torrents, chat, and voice signals', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const session = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Live Forum',
          tags: [{ key: '1', value: relay.url }, { key: 'b', value: null }],
        },
        async (forumPath) => {
          const forum = await cli('create', 'forum', '--input', forumPath, '--json');

          const postEvents = await cliWatchLines(
            async () => {
              await withJsonFile(
                { title: 'Live post', body: 'streamed into watch mode' },
                async (postPath) => {
                  await cli(
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
                },
              );
            },
            'forum',
            'posts',
            forum.fragment,
            '--relay',
            relay.url,
            '--watch-seconds',
            '1.2',
            '--json',
          );
          expect(postEvents).toHaveLength(1);
          expect(postEvents[0]?.scope).toBe('forum.posts');
          expect(postEvents[0]?.phase).toBe('live');
          expect(postEvents[0]?.entry.payload.t).toBe('Live post');

          const torrentEvents = await cliWatchLines(
            async () => {
              await withBinaryFile('live.torrent', makeTorrentBytes(), async (torrentFilePath) => {
                await cli(
                  'forum',
                  'torrent',
                  'publish',
                  forum.fragment,
                  '--torrent-file',
                  torrentFilePath,
                  '--category',
                  'Docs > Manuals',
                  '--secret',
                  owner.nsec,
                  '--relay',
                  relay.url,
                  '--json',
                );
              });
            },
            'forum',
            'torrents',
            forum.fragment,
            '--relay',
            relay.url,
            '--watch-seconds',
            '1.2',
            '--json',
          );
          expect(torrentEvents).toHaveLength(1);
          expect(torrentEvents[0]?.scope).toBe('forum.torrents');
          expect(torrentEvents[0]?.entry.torrentData.title).toBe('Archive');

          const chatEvents = await cliWatchLines(
            async () => {
              await withJsonFile(
                { message: 'Live general chat' },
                async (chatPath) => {
                  await cli(
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
                },
              );
            },
            'forum',
            'chat',
            'list',
            forum.fragment,
            '--relay',
            relay.url,
            '--watch-seconds',
            '1.2',
            '--json',
          );
          expect(chatEvents).toHaveLength(1);
          expect(chatEvents[0]?.scope).toBe('forum.chat');
          expect(chatEvents[0]?.entry.payload.b).toBe('Live general chat');
          expect(chatEvents[0]?.entry.payload.sp).toBe(session.pubkeyHex);

          const voiceEvents = await cliWatchLines(
            async () => {
              await withJsonFile(
                { type: 'join', channel: 'general' },
                async (voicePath) => {
                  await cli(
                    'forum',
                    'voice',
                    'send',
                    forum.fragment,
                    '--input',
                    voicePath,
                    '--secret',
                    owner.nsec,
                    '--session-secret',
                    session.secretHex,
                    '--relay',
                    relay.url,
                    '--json',
                  );
                },
              );
            },
            'forum',
            'voice',
            'list',
            forum.fragment,
            '--channel',
            'general',
            '--relay',
            relay.url,
            '--watch-seconds',
            '1.2',
            '--json',
          );
          expect(voiceEvents).toHaveLength(1);
          expect(voiceEvents[0]?.scope).toBe('forum.voice');
          expect(voiceEvents[0]?.entry.payload.type).toBe('join');
          expect(voiceEvents[0]?.entry.joinSignatureValid).toBe(true);
        },
      );
    } finally {
      destroyPool();
      await relay.close();
    }
  });

  test('forum identity mode rules reject anonymous posting when disabled and signed posting when only anonymous is allowed', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Signed Only Forum',
          tags: [{ key: 'i', value: '0' }, { key: '1', value: relay.url }],
        },
        async (signedOnlyPath) => {
          const signedOnly = await cli('create', 'forum', '--input', signedOnlyPath, '--json');
          await withJsonFile(
            { title: 'Need identity', body: 'No anonymous allowed' },
            async (postPath) => {
              const stderr = await cliFailure(
                'forum',
                'post',
                signedOnly.fragment,
                '--input',
                postPath,
                '--relay',
                relay.url,
                '--json',
              );
              expect(stderr).toContain('This forum requires a Nostr identity.');
            },
          );
        },
      );

      await withJsonFile(
        {
          pubkey: owner.npub,
          name: 'Anonymous Only Forum',
          tags: [{ key: 'i', value: '2' }, { key: '1', value: relay.url }],
        },
        async (anonymousOnlyPath) => {
          const anonymousOnly = await cli('create', 'forum', '--input', anonymousOnlyPath, '--json');
          await withJsonFile(
            { title: 'Signed blocked', body: 'Nostr sign-in disabled' },
            async (postPath) => {
              const stderr = await cliFailure(
                'forum',
                'post',
                anonymousOnly.fragment,
                '--input',
                postPath,
                '--secret',
                owner.nsec,
                '--relay',
                relay.url,
                '--json',
              );
              expect(stderr).toContain('This forum only allows anonymous participation.');
            },
          );
        },
      );
    } finally {
      destroyPool();
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

  test('store, petition, and forum management commands can use the persisted remote signer session', { timeout: 60000 }, async () => {
    const relay = await startMockRelay();
    const signer = await startMockNostrConnectSigner({ relayUrl: relay.url });

    try {
      await withTempDir('nowhere-cli-signer-', async (configHome) => {
        const env = { XDG_CONFIG_HOME: configHome };
        await cliWithEnv(env, 'signer', 'connect', '--bunker', signer.bunkerUri, '--json');

        await withJsonFile(
          {
            pubkey: signer.npub,
            name: 'Signer Store',
            items: [{ name: 'Zine', price: 12 }],
            tags: [
              { key: '1', value: relay.url },
              { key: '2', value: relay.url },
              { key: '$', value: 'USD' },
              { key: 'k', value: null },
              { key: 's', value: '300' },
            ],
          },
          async (storePath) => {
            const store = await cliWithEnv(env, 'create', 'store', '--input', storePath, '--use-signer', '--json');

            await withJsonFile(
              {
                buyer: { name: 'Alex', email: 'alex@example.com' },
                items: [{ i: 0, qty: 1 }],
                subtotal: 12,
                shipping: 3,
                total: 15,
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

                await withJsonFile(published.receiptPayload, async (receiptPath) => {
                  const receipt = await cliWithEnv(
                    env,
                    'store',
                    'receipt',
                    'decrypt',
                    '--input',
                    receiptPath,
                    '--use-signer',
                    '--json',
                  );
                  expect(receipt.order.orderId).toBe(published.order.orderId);

                  const fetchedOrders = await cliWithEnv(
                    env,
                    'store',
                    'orders',
                    store.fragment,
                    '--use-signer',
                    '--relay',
                    relay.url,
                    '--json',
                  );
                  expect(fetchedOrders.orders).toHaveLength(1);

                  const verified = await cliWithEnv(
                    env,
                    'store',
                    'verify',
                    store.fragment,
                    '--input',
                    receiptPath,
                    '--use-signer',
                    '--json',
                  );
                  expect(verified.ok).toBe(true);
                });
              },
            );

            await withJsonFile(
              { notice: 'Inventory rotated' },
              async (statusPath) => {
                const publishedStatus = await cliWithEnv(
                  env,
                  'store',
                  'status',
                  'publish',
                  store.fragment,
                  '--input',
                  statusPath,
                  '--use-signer',
                  '--relay',
                  relay.url,
                  '--json',
                );
                expect(publishedStatus.payload.notice).toBe('Inventory rotated');
              },
            );
          },
        );

        await withJsonFile(
          {
            pubkey: signer.npub,
            name: 'Signer Petition',
            tags: [
              { key: '1', value: relay.url },
              { key: 'N', value: null },
            ],
          },
          async (petitionPath) => {
            const petition = await cliWithEnv(env, 'create', 'petition', '--input', petitionPath, '--use-signer', '--json');

            await withJsonFile(
              { name: 'Signer Supporter' },
              async (signaturePath) => {
                const published = await cliWithEnv(
                  env,
                  'petition',
                  'sign',
                  petition.fragment,
                  '--input',
                  signaturePath,
                  '--use-signer',
                  '--relay',
                  relay.url,
                  '--pow-difficulty',
                  '8',
                  '--json',
                );
                expect(published.signerPubkeyHex).toBe(signer.pubkeyHex);
              },
            );

            const signatures = await cliWithEnv(
              env,
              'petition',
              'signatures',
              petition.fragment,
              '--use-signer',
              '--relay',
              relay.url,
              '--pow-difficulty',
              '8',
              '--json',
            );
            expect(signatures.signatures).toHaveLength(1);
            expect(signatures.signatures[0]?.payload.name).toBe('Signer Supporter');
          },
        );

        await withJsonFile(
          {
            pubkey: signer.npub,
            name: 'Signer Forum',
            tags: [{ key: '1', value: relay.url }],
          },
          async (forumPath) => {
            const forum = await cliWithEnv(env, 'create', 'forum', '--input', forumPath, '--use-signer', '--json');

            await withJsonFile(
              { title: 'Remote signer thread', body: 'Signed without exporting the key' },
              async (postPath) => {
                const post = await cliWithEnv(
                  env,
                  'forum',
                  'post',
                  forum.fragment,
                  '--input',
                  postPath,
                  '--use-signer',
                  '--relay',
                  relay.url,
                  '--json',
                );
                expect(post.authorPubkeyHex).toBe(signer.pubkeyHex);
              },
            );

            await withJsonFile(
              { message: 'Signer chat online' },
              async (chatPath) => {
                await cliWithEnv(
                  env,
                  'forum',
                  'chat',
                  'send',
                  forum.fragment,
                  '--input',
                  chatPath,
                  '--use-signer',
                  '--relay',
                  relay.url,
                  '--json',
                );
              },
            );

            const messages = await cliWithEnv(
              env,
              'forum',
              'chat',
              'list',
              forum.fragment,
              '--relay',
              relay.url,
              '--json',
            );
            expect(messages.messages.some((entry: { payload: { p: string; b: string } }) => (
              entry.payload.p === signer.pubkeyHex && entry.payload.b === 'Signer chat online'
            ))).toBe(true);
          },
        );
      });
    } finally {
      destroyPool();
      await signer.close();
      await relay.close();
    }
  });
});
