import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { countEvents, destroyPool, getPool, publishToRelays, publishToRelaysBestEffort } =
  await import(pathToFileURL(resolve("src/lib/relay.ts")));
const pool = getPool();
const relays = ["wss://first.example.test", "wss://second.example.test"];

try {
  pool.publish = () => [Promise.resolve("connection failure: fixture"), Promise.reject(Error("rejected"))];
  await assert.rejects(publishToRelays({}, relays), /Failed to publish to any relay/);
  await publishToRelaysBestEffort({}, relays);

  pool.publish = () => [Promise.resolve("connection failure: fixture"), Promise.resolve("")];
  await publishToRelays({}, relays);

  pool.ensureRelay = async url => ({
    count: async () => url === relays[0] ? 0 : 2,
  });
  pool.querySync = async () => { throw Error("query should not run when count succeeds"); };
  assert.equal(await countEvents({}, relays), 2);

  pool.ensureRelay = async () => { throw Error("no count response"); };
  pool.querySync = async () => [{}, {}];
  assert.equal(await countEvents({}, relays), 2);
  console.log("Strict publish, best effort, count selection and fallback behaved as expected.");
} finally {
  destroyPool();
}
