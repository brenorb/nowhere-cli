import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(join(tmpdir(), "nowhere-signer-fixture-"));
process.env.XDG_CONFIG_HOME = root;
const directory = join(root, "nowhere-cli");
const path = join(directory, "active-signer.json");
const original = "invalid JSON";
try {
  await mkdir(directory);
  await writeFile(path, original);
  const { getActiveSignerStatus } = await import(pathToFileURL(resolve("src/lib/active-signer.ts")));
  if (process.argv.includes("--expect-legacy")) {
    assert.equal((await getActiveSignerStatus()).connected, false);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    console.log("The cited status command removed malformed settings.");
  } else {
    await assert.rejects(getActiveSignerStatus(), /Failed to read the persisted signer/);
    assert.equal(await readFile(path, "utf8"), original);
    console.log("Status reported malformed settings and preserved the original file.");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
