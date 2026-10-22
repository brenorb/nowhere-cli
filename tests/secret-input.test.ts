import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nip19 } from 'nostr-tools';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getActiveSignerPath, getActiveSignerStatus } from '../src/lib/active-signer.js';
import { setStoreOrderNote } from '../src/lib/store-manage-state.js';
import { getForumSessionMaterial, getForumSessionPath } from '../src/lib/forum-session.js';

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL('..', import.meta.url));
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'nowhere-secrets-')); dirs.push(dir); return dir; }
const run = (...args: string[]) => exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd });

describe('secret files', () => {
  test('required secrets can be read from a file without putting the key in argv', async () => {
    const path = join(await directory(), 'key');
    await writeFile(path, `${'1'.repeat(64)}\n`);
    const result = await run('pubkey', '--secret-file', path, '--json');
    expect(JSON.parse(result.stdout).pubkeyHex).toHaveLength(64);
    expect(result.stderr).toBe('');
  });

  test('ambiguous secret sources fail without echoing their contents', async () => {
    const path = join(await directory(), 'key');
    await writeFile(path, '1'.repeat(64));
    await expect(run('pubkey', '--secret', '2'.repeat(64), '--secret-file', path)).rejects.toMatchObject({
      stdout: '', stderr: expect.stringContaining('Choose either --secret or --secret-file'),
    });
  });

  test('forum session secret is private even with permissive process umask', async () => {
    const dir = await directory();
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    vi.stubEnv('NOWHERE_FORUM_SESSION_SECRET', '');
    const before = process.umask(0);
    try {
      await getForumSessionMaterial();
      const path = getForumSessionPath();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'nowhere-cli'))).mode & 0o777).toBe(0o700);
      expect(JSON.parse(await readFile(path, 'utf8')).secretHex).toHaveLength(64);
    } finally { process.umask(before); }
  });
  test('corrupt persisted credentials are reported and preserved for recovery', async () => {
    const dir = await directory();
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    await mkdir(join(dir, 'nowhere-cli'));
    const path = getActiveSignerPath();
    await writeFile(path, '{broken private credentials');
    await expect(getActiveSignerStatus()).rejects.toThrow('Failed to read the persisted signer');
    expect(await readFile(path, 'utf8')).toBe('{broken private credentials');
  });

  test('corrupt order state cannot be silently overwritten by a mutation', async () => {
    const dir = await directory();
    vi.stubEnv('XDG_CONFIG_HOME', dir);
    await mkdir(join(dir, 'nowhere-cli'));
    const path = join(dir, 'nowhere-cli', 'store-manage.json');
    await writeFile(path, '{broken order notes');
    await expect(setStoreOrderNote('store', 'order', 'new note')).rejects.toThrow('Failed to read store management state');
    expect(await readFile(path, 'utf8')).toBe('{broken order notes');
  });

  test.each(['--secret', '--secret-file'])('malformed nsec never leaks its key payload through errors (%s)', async (flag) => {
    const valid = nip19.nsecEncode(new Uint8Array(32).fill(1));
    const secret = `${valid.slice(0, -1)}${valid.endsWith('q') ? 'p' : 'q'}`;
    const path = join(await directory(), 'invalid-key');
    await writeFile(path, secret);
    try {
      await run('pubkey', flag, flag.endsWith('-file') ? path : secret, '--json');
      throw new Error('Expected invalid key to fail');
    } catch (error) {
      const result = error as { stdout: string; stderr: string };
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Invalid nsec secret key');
      expect(result.stderr).not.toContain(secret.slice(0, -6));
    }
  });

});
