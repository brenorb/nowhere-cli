import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const legacy = process.argv.includes("--expect-legacy");
const { NostrConnectClient } = await import(pathToFileURL(resolve("src/lib/nostr-connect-client.ts")));
if (!legacy) {
  const { setRequestTimeoutMs } = await import(pathToFileURL(resolve("src/lib/network.ts")));
  setRequestTimeoutMs(15);
}
const pool = {
  subscribe: () => ({ close() {} }),
  publish: () => [Promise.resolve("")],
};
const client = new NostrConnectClient({
  pool,
  relays: ["wss://fixture.example.test"],
  clientSecretHex: "0000000000000000000000000000000000000000000000000000000000000001",
  remotePubkey: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
});
try {
  const result = await Promise.race([
    client.getPublicKey().then(() => "resolved", error => error.message),
    sleep(100, "still pending"),
  ]);
  if (legacy) {
    assert.equal(result, "still pending");
  } else {
    assert.match(result, /before the request timeout/);
  }
  console.log(result);
} finally {
  client.close();
}
