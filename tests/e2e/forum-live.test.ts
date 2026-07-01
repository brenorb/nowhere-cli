import { afterEach, describe, expect, test } from 'vitest';
import { encodeForum, type ForumData } from '@nowhere/codec';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import { startMockRelay, type MockRelayHandle } from '../support/mockRelay.js';
import {
  getTopicTagMap,
  listForumPosts,
  listForumReplies,
  listForumTorrents,
  listGeneralChatMessages,
  publishForumPostFromInput,
  publishForumReplyFromInput,
  publishForumTorrentFromInput,
  publishGeneralChatMessage,
  TORRENT_TOPIC_SEED,
} from '../../src/lib/forum-live.js';

let relay: MockRelayHandle | null = null;

afterEach(async () => {
  if (relay) {
    await relay.close();
    relay = null;
  }
});

function makeForum(pubkey: string): string {
  const data: ForumData = {
    version: 1,
    siteType: 'discussion',
    pubkey,
    name: 'Field Forum',
    description: 'Private coordination',
    tags: [
      { key: 'i', value: '1' },
      { key: 'H', value: '0' },
      { key: 'V', value: undefined },
      { key: 'O', value: 'Ops\\pLogistics' },
    ],
  };
  return encodeForum(data).fragment;
}

describe('forum runtime module', () => {
  test('publishes and lists forum posts', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey);

    const published = await publishForumPostFromInput({
      forumInput: forumFragment,
      topic: 'Ops',
      title: 'Checkpoint',
      body: 'Meet at 20:00 UTC',
      secret: owner.nsec,
      relays: [relay.url],
    });

    expect(published.postTag).toHaveLength(32);
    const posts = await listForumPosts({ forumInput: forumFragment, topic: 'Ops', relays: [relay.url] });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.payload.t).toBe('Checkpoint');
    expect(posts[0]?.topic).toBe('Ops');
  });

  test('publishes and lists replies via post event lookup', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey);

    const post = await publishForumPostFromInput({
      forumInput: forumFragment,
      title: 'Supply Run',
      body: 'Bring radios',
      secret: owner.secretHex,
      relays: [relay.url],
    });

    await publishForumReplyFromInput({
      forumInput: forumFragment,
      postEventId: post.event.id,
      body: 'Confirmed',
      secret: owner.nsec,
      relays: [relay.url],
    });

    const replies = await listForumReplies({
      forumInput: forumFragment,
      postEventId: post.event.id,
      relays: [relay.url],
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload.b).toBe('Confirmed');
  });

  test('publishes and lists torrent posts', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey);

    await publishForumTorrentFromInput({
      forumInput: forumFragment,
      secret: owner.secretHex,
      relays: [relay.url],
      torrent: {
        x: '0123456789abcdef0123456789abcdef01234567',
        title: 'Archive',
        description: 'Encrypted media',
        files: [{ path: 'archive.zip', size: 1024 }],
        trackers: ['udp://tracker.example.com:80'],
        category: 'docs',
        refs: ['ref:1'],
      },
    });

    const torrents = await listForumTorrents({ forumInput: forumFragment, relays: [relay.url] });
    expect(torrents).toHaveLength(1);
    expect(torrents[0]?.torrentData.title).toBe('Archive');
    expect(getTopicTagMap(forumFragment).some((entry) => entry.topic === TORRENT_TOPIC_SEED)).toBe(false);
  });

  test('publishes and lists general chat messages', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey);

    await publishGeneralChatMessage({
      forumInput: forumFragment,
      message: 'General chat online',
      secret: owner.nsec,
      relays: [relay.url],
    });

    const messages = await listGeneralChatMessages({ forumInput: forumFragment, relays: [relay.url] });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload.b).toBe('General chat online');
  });
});
