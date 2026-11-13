import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const local = (path) => import(pathToFileURL(join(process.cwd(), path)).href);
const { generateSecretMaterial } = await local('src/lib/keys.ts');
const {
  countPetitionSignatures,
  fetchPetitionSignaturesForOwner,
  publishPetitionSignature,
} = await local('src/lib/petition-live.ts');

const owner = generateSecretMaterial();
const fragment = 'local-petition-fixture';
const relays = ['wss://relay.example.invalid'];
const events = [];
const pages = [];
const transport = {
  async publish(event) { events.push(event); },
  async count() { return events.length; },
  async fetch(filter) {
    pages.push(filter.until);
    return events
      .filter((event) => filter.until === undefined || event.created_at <= filter.until)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 1);
  },
};
const common = {
  fragment, creatorPubkeyHex: owner.pubkeyHex, relays, transport, powDifficulty: 0,
};
await assert.rejects(
  publishPetitionSignature({ ...common, payload: {}, petitionTags: [{ key: 'N' }] }),
  /Name is required/,
);
assert.equal(events.length, 0);

for (const [name, timestamp] of [['first', 2000], ['second', 2000], ['older', 1000]]) {
  await publishPetitionSignature({
    ...common, payload: { name }, timestamp, secret: generateSecretMaterial().secretHex,
  });
}
const count = await countPetitionSignatures({ fragment, relays, transport });
const result = await fetchPetitionSignaturesForOwner({ ...common, ownerSecret: owner.secretHex });
assert.deepEqual(pages, [undefined, 1, 0]);
assert.equal(count.count, 3);
assert.equal(result.rawEventCount, 2);
assert.deepEqual(result.signatures.map((entry) => entry.payload?.name), ['first', 'older']);
console.log('The relay counted three signatures. The owner fetch skipped one at the page boundary.');
