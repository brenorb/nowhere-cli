import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requireFromRepo = createRequire(resolve("package.json"));
const { encode } = await import(pathToFileURL(requireFromRepo.resolve("@nowhere/codec")));
const { generateSecretMaterial } = await import(pathToFileURL(resolve("src/lib/keys.ts")));
const { beginStoreCheckout, quoteStoreCheckout } = await import(pathToFileURL(resolve("src/lib/store-checkout.ts")));
const seller = generateSecretMaterial();
let published = 0;
const relay = {
  publish: async () => { published += 1; },
  fetchEvent: async () => null,
  fetchEvents: async () => [],
};
const items = [{ i: 0, qty: 1 }];
const store = discontinued => "https://hostednowhere.com/s#" + encode({
  version: 1,
  name: "Local checkout fixture",
  description: "No external requests",
  pubkey: seller.nowherePubkey,
  tags: [
    { key: "$", value: "USD" },
    { key: "2", value: "wss://orders.example.test" },
    { key: "5", value: "*USD:Wire:fixture" },
  ],
  items: [{ name: "Fixture item", price: 10, tags: discontinued ? [{ key: "o" }] : [] }],
}).fragment;
globalThis.fetch = async () => { throw Error("unexpected external request"); };

const blocked = { storeUrl: store(true), items, buyer: {}, methodId: "custom_0" };
assert.equal((await quoteStoreCheckout(blocked, relay)).items[0].unavailable, true);
await assert.rejects(beginStoreCheckout(blocked, relay), /sold-out or unavailable items/);
assert.equal(published, 0);

const allowed = await beginStoreCheckout({ ...blocked, storeUrl: store(false) }, relay);
assert.equal(allowed.flow, "manual");
assert.equal(published, 1);
console.log("Quote disclosed unavailability and only the available cart published an order.");
