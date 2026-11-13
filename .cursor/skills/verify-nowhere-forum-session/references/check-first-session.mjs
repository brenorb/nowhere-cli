import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { getForumSessionMaterial, getForumSessionPath } = await import(
  pathToFileURL(join(process.cwd(), 'src/lib/forum-session.ts')).href
);

const temporary = await mkdtemp(join(tmpdir(), 'nowhere-forum-session-'));
process.env.XDG_CONFIG_HOME = temporary;
delete process.env.NOWHERE_FORUM_SESSION_SECRET;
try {
  const [first, second] = await Promise.all([
    getForumSessionMaterial(),
    getForumSessionMaterial(),
  ]);
  assert.notEqual(first.pubkeyHex, second.pubkeyHex, 'first callers shared the same identity');
  const path = getForumSessionPath();
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.ok([first.secretHex, second.secretHex].includes(persisted.secretHex));
  assert.equal((await getForumSessionMaterial()).secretHex, persisted.secretHex);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  console.log('Two first calls returned different identities and only one was saved.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
