import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const invoke = (input, ...extra) => spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli.ts", "create", "drop", "--interactive", "--json", ...extra],
  { input, encoding: "utf8", timeout: 10000 },
);

const rejected = invoke("Line one\n\nV\n\nn\n", "--name", "Field Notes");
assert.equal(rejected.status, 1, "declining the summary must fail");
assert.match(rejected.stderr, /Create cancelled/);
assert.equal(rejected.stdout, "");

const accepted = invoke("Line one\n\nV\n\ny\n", "--name", "Field Notes");
assert.equal(accepted.status, 0, accepted.stderr);
assert.ok(JSON.parse(accepted.stdout).fragment);

const missing = invoke("");
assert.equal(missing.status, 1);
assert.equal(missing.stdout, "");
assert.match(missing.stderr, /ended before all answers/);
console.log("Declining and missing required answers prevent creation.");
