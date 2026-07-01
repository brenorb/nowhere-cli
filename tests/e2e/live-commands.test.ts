import { describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import { startMockRelay } from '../support/mockRelay.js';

const execFileAsync = promisify(execFile);
const cwd = '/Users/REDACTED';

async function cli(...args: string[]) {
  const result = await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], { cwd });
  return JSON.parse(result.stdout);
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

describe('relay-backed CLI commands', () => {
  test('store commands publish orders, decrypt receipts, and manage status', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const seller = generateSecretMaterial();

    try {
      await withJsonFile(
        {
          pubkey: seller.npub,
          name: 'Freedom Market',
          items: [{ name: 'Zine', price: 12, tags: [{ key: 'f', value: null }] }],
          tags: [
            { key: '1', value: relay.url },
            { key: '2', value: relay.url },
            { key: 'k', value: null },
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
              });

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

              expect(fetchedOrders.orders).toHaveLength(1);
              expect(fetchedOrders.orders[0]?.order.total).toBe(27);
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
            { key: '1', value: relay.url },
          ],
        },
        async (petitionPath) => {
          const petition = await cli('create', 'petition', '--input', petitionPath, '--json');

          await withJsonFile(
            {
              ts: Date.now(),
              name: 'Casey',
              email: 'casey@example.com',
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
            },
          );
        },
      );
    } finally {
      await relay.close();
    }
  });

  test('forum commands publish posts, replies, torrents, room flows, and chat', { timeout: 30000 }, async () => {
    const relay = await startMockRelay();
    const owner = generateSecretMaterial();

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
            { key: '1', value: relay.url },
            { key: 'O', value: 'Ops\\pLogistics' },
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

          await withJsonFile(
            {
              x: '0123456789abcdef0123456789abcdef01234567',
              title: 'Archive',
              description: 'Encrypted media',
              files: [{ path: 'archive.zip', size: 1024 }],
              trackers: ['udp://tracker.example.com:80'],
              category: 'docs',
              refs: ['ref:1'],
            },
            async (torrentPath) => {
              const torrent = await cli(
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

              expect(torrent.postTag).toHaveLength(32);

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
            },
          );

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
              expect(
                listed.messages.some((message: { payload: { room?: { name: string } | string } }) =>
                  typeof message.payload.room === 'object' && message.payload.room?.name === 'Logistics'),
              ).toBe(true);
            },
          );
        },
      );
    } finally {
      await relay.close();
    }
  });
});
