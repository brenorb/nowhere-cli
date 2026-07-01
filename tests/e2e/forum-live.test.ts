import { afterEach, describe, expect, test } from 'vitest';
import { encodeForum, type ForumData } from '@nowhere/codec';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import { startMockRelay, type MockRelayHandle } from '../support/mockRelay.js';
import {
  buildMagnetLink,
  getTopicTagMap,
  listForumPosts,
  listForumReplies,
  listForumTorrentReplies,
  listForumTorrents,
  listGeneralChatMessages,
  listPrivateChatMessages,
  listRoomAnnouncements,
  listRoomChatMessages,
  publishForumPostFromInput,
  publishForumReplyFromInput,
  publishForumTorrentReplyFromInput,
  publishForumTorrentFromInput,
  publishGeneralChatMessage,
  publishPrivateChatMessage,
  publishRoomAnnouncement,
  publishRoomChatMessage,
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

  test('isolates salted forum posts from the unsalted forum namespace', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey);

    await publishForumPostFromInput({
      forumInput: forumFragment,
      title: 'Salted thread',
      body: 'Same forum, different keyspace',
      secret: owner.nsec,
      relays: [relay.url],
      salt: 'rotation-1',
    });

    const unsaltedPosts = await listForumPosts({ forumInput: forumFragment, relays: [relay.url] });
    const saltedPosts = await listForumPosts({
      forumInput: forumFragment,
      relays: [relay.url],
      salt: 'rotation-1',
    });

    expect(unsaltedPosts).toHaveLength(0);
    expect(saltedPosts).toHaveLength(1);
    expect(saltedPosts[0]?.payload.t).toBe('Salted thread');
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

    const torrent = await publishForumTorrentFromInput({
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
    expect(torrents[0]?.magnetLink).toBe(buildMagnetLink(torrents[0]!.torrentData));
    expect(getTopicTagMap(forumFragment).some((entry) => entry.topic === TORRENT_TOPIC_SEED)).toBe(false);

    await publishForumTorrentReplyFromInput({
      forumInput: forumFragment,
      torrentEventId: torrent.event.id,
      body: 'Seeding confirmed',
      secret: owner.nsec,
      relays: [relay.url],
    });

    const replies = await listForumTorrentReplies({
      forumInput: forumFragment,
      torrentEventId: torrent.event.id,
      relays: [relay.url],
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload.b).toBe('Seeding confirmed');
  });

  test('publishes general chat with a session pubkey and decrypts private chat for that session', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const session = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey);

    await publishGeneralChatMessage({
      forumInput: forumFragment,
      message: 'General chat online',
      secret: owner.nsec,
      sessionSecret: session.secretHex,
      relays: [relay.url],
    });

    const messages = await listGeneralChatMessages({ forumInput: forumFragment, relays: [relay.url] });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload.b).toBe('General chat online');
    expect(messages[0]?.payload.sp).toBe(session.pubkeyHex);

    await publishPrivateChatMessage({
      forumInput: forumFragment,
      recipientSessionPubkey: session.pubkeyHex,
      message: 'Encrypted side-channel',
      secret: owner.secretHex,
      relays: [relay.url],
    });

    const privateMessages = await listPrivateChatMessages({
      forumInput: forumFragment,
      sessionSecret: session.nsec,
      relays: [relay.url],
    });
    expect(privateMessages).toHaveLength(1);
    expect(privateMessages[0]?.payload.b).toBe('Encrypted side-channel');
    expect(privateMessages[0]?.peerPubkey).toBe(owner.pubkeyHex);
  });

  test('publishes room announcements and decrypts room chat with the shared access code', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey);

    await publishRoomAnnouncement({
      forumInput: forumFragment,
      roomName: 'Logistics',
      accessCode: 'shared-secret',
      secret: owner.nsec,
      relays: [relay.url],
    });

    const announcements = await listRoomAnnouncements({ forumInput: forumFragment, relays: [relay.url] });
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.roomName).toBe('Logistics');

    await publishRoomChatMessage({
      forumInput: forumFragment,
      roomName: 'Logistics',
      accessCode: 'shared-secret',
      message: 'Meet at fallback point B',
      secret: owner.secretHex,
      relays: [relay.url],
    });

    const roomMessages = await listRoomChatMessages({
      forumInput: forumFragment,
      roomName: 'Logistics',
      accessCode: 'shared-secret',
      relays: [relay.url],
    });
    expect(roomMessages).toHaveLength(1);
    expect(roomMessages[0]?.payload.b).toBe('Meet at fallback point B');
  });
});
