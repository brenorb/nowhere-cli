import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = createRequire(join(process.cwd(), 'package.json'));
const { encodeMessage, encodeFundraiser } = await import(
  pathToFileURL(project.resolve('@nowhere/codec')).href
);
const local = (path) => import(pathToFileURL(join(process.cwd(), path)).href);
const { createMessageTipInvoice } = await local('src/lib/message-tips.ts');
const { createFundraiserDonationInvoice } = await local('src/lib/fundraiser-donate.ts');
const { generateSecretMaterial } = await local('src/lib/keys.ts');

const common = {
  version: 1, name: 'Fixture', description: 'Fixture description',
  tags: [{ key: 'l', value: 'tips@seller.test,*Other:other.test' }],
};
const fragment = encodeMessage({ ...common, siteType: 'message' }).fragment;
const fundraiser = encodeFundraiser({
  ...common, siteType: 'fundraiser', pubkey: generateSecretMaterial().nowherePubkey, goal: 100,
}).fragment;
const actions = [
  (sats, methodId) => createMessageTipInvoice({ messageInput: fragment, sats, methodId }),
  (sats, methodId) => createFundraiserDonationInvoice({ fundraiserInput: fundraiser, sats, methodId }),
];

const original = globalThis.fetch;
const requests = [];
globalThis.fetch = async (input) => {
  const url = new URL(input);
  requests.push(url);
  assert.equal(url.host, 'seller.test');
  if (url.pathname.startsWith('/.well-known/')) {
    return Response.json({
      callback: 'https://seller.test/invoice', minSendable: 2000, maxSendable: 4000,
    });
  }
  assert.equal(url.pathname, '/invoice');
  const amount = url.searchParams.get('amount');
  return Response.json({ pr: `local-invoice-${amount}` });
};
try {
  for (const run of actions) {
    requests.length = 0;
    await assert.rejects(run(1.5), /positive integer/);
    await assert.rejects(run(3, 'custom_0'), /does not support/);
    assert.equal(requests.length, 0);
    await assert.rejects(run(1), /between 2 and 4/);
    await assert.rejects(run(5), /between 2 and 4/);
    assert.equal(requests.filter((url) => url.pathname === '/invoice').length, 0);
    assert.equal((await run(2)).invoice, 'local-invoice-2000');
    assert.equal((await run(4)).invoice, 'local-invoice-4000');
  }
  console.log('Both invoice flows rejected unsupported or out-of-range inputs before the callback.');
} finally {
  globalThis.fetch = original;
}
