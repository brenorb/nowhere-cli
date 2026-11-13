import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { fetchWithTimeout, setRequestTimeoutMs } from "../../../../src/lib/network.ts";

const server = createServer((req, res) => {
  if (req.url === "/headers") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first chunk");
  }
  if (req.url === "/complete") res.end("done");
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  setRequestTimeoutMs(500);
  assert.equal(await (await fetchWithTimeout(origin + "/complete")).text(), "done");
  const response = await fetchWithTimeout(origin + "/headers");
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), error => ["AbortError", "TimeoutError"].includes(error.name));

  setRequestTimeoutMs(50);
  await assert.rejects(fetchWithTimeout(origin + "/pending"), error => error.name === "TimeoutError");

  setRequestTimeoutMs(200);
  const caller = new AbortController();
  const pending = fetchWithTimeout(origin + "/pending", { signal: caller.signal });
  caller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/);
} finally {
  server.closeAllConnections();
  server.close();
}
console.log("Loopback fetch completion, deadline, body cancellation and caller cancellation passed");
