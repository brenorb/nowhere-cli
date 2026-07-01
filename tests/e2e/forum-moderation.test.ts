import { encodeForum, type ForumData } from '@nowhere/codec';
import { afterEach, describe, expect, test } from 'vitest';
import { finalizeEvent } from 'nostr-tools/pure';
import { generateSecretMaterial } from '../../src/lib/keys.js';
import { publishForumPostFromInput } from '../../src/lib/forum-live.js';
import { checkForumWotAccess, getForumModerationConfig, buildForumWotSet, passesForumModeration } from '../../src/lib/forum-moderation.js';
import { destroyPool, publishToRelays } from '../../src/lib/relay.js';
import { startMockRelay, type MockRelayHandle } from '../support/mockRelay.js';

let relay: MockRelayHandle | null = null;

afterEach(async () => {
  destroyPool();
  if (relay) {
    await relay.close();
    relay = null;
  }
});

function makeForum(pubkey: string, relayUrl: string): string {
  const data: ForumData = {
    version: 1,
    siteType: 'discussion',
    pubkey,
    name: 'Moderated Forum',
    tags: [
      { key: '1', value: relayUrl },
      { key: '2', value: relayUrl },
      { key: 'W', value: '1' },
      { key: '3', value: '1' },
      { key: '4', value: '1' },
      { key: '5', value: '1' },
      { key: 'X', value: 'blocked' },
    ],
  };
  return encodeForum(data).fragment;
}

async function publishFollowList(secret: Uint8Array, relays: string[], follows: string[]) {
  const event = finalizeEvent({
    kind: 3,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: follows.map((pubkey) => ['p', pubkey]),
  }, secret);
  await publishToRelays(event, relays);
}

describe('forum moderation helpers', () => {
  test('builds WOT sets and evaluates author access and banned words', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const trusted = generateSecretMaterial();
    const outsider = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey, relay.url);

    await publishFollowList(owner.secretKey, [relay.url], [trusted.pubkeyHex]);

    const config = await getForumModerationConfig(forumFragment, 'post', [relay.url]);
    const wotSet = await buildForumWotSet(config);

    expect(wotSet?.has(owner.pubkeyHex)).toBe(true);
    expect(wotSet?.has(trusted.pubkeyHex)).toBe(true);
    expect(wotSet?.has(outsider.pubkeyHex)).toBe(false);
    expect(passesForumModeration(trusted.pubkeyHex, 'clean post', wotSet ?? null, config.bannedWords)).toBe(true);
    expect(passesForumModeration(trusted.pubkeyHex, 'blocked payload', wotSet ?? null, config.bannedWords)).toBe(false);

    const trustedAccess = await checkForumWotAccess({
      forumInput: forumFragment,
      scope: 'post',
      author: trusted.pubkeyHex,
      profileRelays: [relay.url],
    });
    const outsiderAccess = await checkForumWotAccess({
      forumInput: forumFragment,
      scope: 'post',
      author: outsider.npub,
      profileRelays: [relay.url],
    });

    expect(trustedAccess.allowed).toBe(true);
    expect(outsiderAccess.allowed).toBe(false);
    expect(outsiderAccess.depth).toBe(1);
  });

  test('keeps the raw forum listing separate from moderation filtering inputs', async () => {
    relay = await startMockRelay();
    const owner = generateSecretMaterial();
    const trusted = generateSecretMaterial();
    const outsider = generateSecretMaterial();
    const forumFragment = makeForum(owner.nowherePubkey, relay.url);

    await publishFollowList(owner.secretKey, [relay.url], [trusted.pubkeyHex]);

    const allowedPost = await publishForumPostFromInput({
      forumInput: forumFragment,
      title: 'Allowed post',
      body: 'clean text',
      secret: trusted.secretHex,
      relays: [relay.url],
    });
    const blockedPost = await publishForumPostFromInput({
      forumInput: forumFragment,
      title: 'Blocked post',
      body: 'blocked phrase',
      secret: outsider.secretHex,
      relays: [relay.url],
    });

    expect(allowedPost.event.id).not.toBe(blockedPost.event.id);
  });
});
