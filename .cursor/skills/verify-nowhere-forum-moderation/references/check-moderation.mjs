import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { buildForumWotSet, passesForumModeration } = await import(
  pathToFileURL(join(process.cwd(), 'src/lib/forum-moderation.ts')).href
);
const graph = await buildForumWotSet({
  depth: 0, creatorPubkeyHex: 'owner', bannedWords: ['blocked'], profileRelays: [],
});
assert.deepEqual([...graph], ['owner']);
assert.equal(passesForumModeration('owner', 'Clean content', graph, ['blocked']), true);
assert.equal(passesForumModeration('owner', 'A BlOcKeD term', graph, ['blocked']), false);
assert.equal(passesForumModeration('outsider', 'Clean content', graph, ['blocked']), false);
assert.equal(passesForumModeration('outsider', 'Clean content', null, ['blocked']), true);
console.log('The owner-only graph and case-insensitive moderation guards held.');
