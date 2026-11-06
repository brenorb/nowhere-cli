import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import { startMockRelay } from '../support/mockRelay.js';
import { startMockNostrConnectSigner } from '../support/mockNostrConnectSigner.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../..', import.meta.url));
let directory: string;
let binary: string;
let environment: NodeJS.ProcessEnv;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nowhere-packed-e2e-'));
  await execute('pnpm', ['build'], { cwd: repository, timeout: 60_000 });
  const packed = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
    cwd: repository, timeout: 60_000,
  });
  const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const installation = join(directory, 'installed');
  await execute('npm', ['install', '--prefix', installation, '--ignore-scripts', '--no-audit', '--no-fund', join(directory, filename)], {
    cwd: directory, timeout: 90_000,
  });
  binary = join(installation, 'node_modules', '.bin', 'nowhere');
  environment = {
    ...process.env,
    XDG_CONFIG_HOME: join(directory, 'config'),
    NOWHERE_FORUM_SESSION_SECRET: '',
    NODE_PATH: '',
    NODE_OPTIONS: '',
  };
  const manifest = JSON.parse(await readFile(join(installation, 'node_modules', 'nowhere-cli', 'package.json'), 'utf8'));
  const version = await execute(binary, ['--version'], { cwd: directory, env: environment, timeout: 15_000 });
  assert.equal(version.stdout.trim(), manifest.version);
  assert.equal(version.stderr, '');
  // No source checkout or development codec is present in the installed tree.
  await assert.rejects(access(join(installation, 'node_modules', '@nowhere', 'codec')));
}, { timeout: 120_000 });

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function json(...args: string[]) {
  const result = await execute(binary, [...args, '--json'], {
    cwd: directory, env: environment, timeout: 20_000,
  });
  assert.equal(result.stderr, '', `unexpected diagnostic from ${args[0]}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function artifact(name: string, contents: unknown): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify(contents), { mode: 0o600 });
  return path;
}

test('packed installation roundtrips keys, signed/encrypted artifacts, and updates', { timeout: 30_000 }, async () => {
  const keys = await json('keygen');
  const keyFile = join(directory, 'local-key');
  const passwordFile = join(directory, 'password');
  await writeFile(keyFile, `${keys.nsec}\n`, { mode: 0o600 });
  await writeFile(passwordFile, 'packed-e2e-only password\n', { mode: 0o600 });
  const derived = await json('pubkey', '--secret-file', keyFile);
  assert.equal(derived.pubkeyHex, keys.pubkeyHex);
  assert.equal(derived.npub, keys.npub);

  const input = await artifact('message.json', {
    pubkey: keys.npub, name: 'Packed installation', description: 'Original body',
    tags: [{ key: 't', value: 'Local end-to-end verification' }],
  });
  const created = await json('create', 'message', '--input', input);
  const createdPath = await artifact('created.json', created);
  const saved = JSON.parse(await readFile(createdPath, 'utf8'));
  const inspected = await json('inspect', saved.url);
  assert.equal(inspected.site.name, 'Packed installation');
  assert.equal(inspected.site.siteType, 'message');

  const signed = await json('sign', saved.fragment, '--secret-file', keyFile);
  const verified = await json('verify', signed.signedFragment);
  assert.equal(verified.signed, true);
  assert.equal(verified.signaturePubkeyHex, keys.pubkeyHex);
  assert.equal(verified.unsignedFragment, saved.fragment);

  const encrypted = await json('encrypt', signed.signedFragment, '--password-file', passwordFile);
  const decrypted = await json('decrypt', encrypted.encryptedUrl, '--password-file', passwordFile);
  assert.equal(decrypted.fragment, signed.signedFragment);
  const secureInspect = await json('inspect', encrypted.encryptedUrl, '--password-file', passwordFile);
  assert.equal(secureInspect.signed, true);
  assert.equal(secureInspect.signaturePubkeyHex, keys.pubkeyHex);

  const patch = await artifact('patch.json', { name: 'Updated packed installation' });
  const updated = await json('update', encrypted.encryptedUrl, '--password-file', passwordFile,
    '--patch', patch, '--sign-secret-file', keyFile, '--encrypt-password-file', passwordFile);
  assert.equal(updated.encrypted, true);
  const updatedInspect = await json('inspect', updated.url, '--password-file', passwordFile);
  assert.equal(updatedInspect.site.name, 'Updated packed installation');
  assert.equal(updatedInspect.signaturePubkeyHex, keys.pubkeyHex);
  assert.equal(updated.siteData.description, 'Original body');
  await artifact('updated.json', updated);

  await assert.rejects(execute(binary, ['decrypt', encrypted.encryptedUrl, '--password', 'wrong-test-password', '--json'], {
    cwd: directory, env: environment, timeout: 15_000,
  }), (failure: unknown) => {
    const result = failure as { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /wrong-test-password|packed-e2e-only|Traceback/);
    return true;
  });
});

test('installed CLI persists NIP46 authorization and publishes signed protocol events locally', { timeout: 30_000 }, async () => {
  const relay = await startMockRelay();
  const signer = await startMockNostrConnectSigner({ relayUrl: relay.url });
  try {
    const bunkerFile = join(directory, 'bunker-uri');
    await writeFile(bunkerFile, signer.bunkerUri, { mode: 0o600 });
    const connected = await json('--request-timeout', '3', 'signer', 'connect', '--bunker-file', bunkerFile);
    assert.equal(connected.connected, true);
    assert.equal(connected.pubkeyHex, signer.pubkeyHex);
    const state = join(environment.XDG_CONFIG_HOME!, 'nowhere-cli', 'active-signer.json');
    assert.equal((await stat(state)).mode & 0o777, 0o600);
    assert.equal((await stat(join(environment.XDG_CONFIG_HOME!, 'nowhere-cli'))).mode & 0o777, 0o700);
    const status = await json('signer', 'status');
    assert.equal(status.pubkeyHex, signer.pubkeyHex);

    const input = await artifact('forum.json', {
      pubkey: signer.npub, name: 'Packed local forum',
      tags: [{ key: 'i', value: '1' }, { key: '1', value: relay.url }],
    });
    const forum = await json('create', 'forum', '--input', input, '--use-signer');
    const verified = await json('verify', forum.fragment);
    assert.equal(verified.signed, true);
    assert.equal(verified.signaturePubkeyHex, signer.pubkeyHex);

    const postInput = await artifact('post.json', { title: 'Packed protocol roundtrip', body: 'Local-only test publication' });
    const post = await json('forum', 'post', forum.fragment, '--input', postInput, '--use-signer', '--relay', relay.url);
    const posts = await json('forum', 'posts', forum.fragment, '--relay', relay.url);
    assert.equal(posts.posts.length, 1);
    assert.equal(posts.posts[0].payload.t, 'Packed protocol roundtrip');
    assert.equal(posts.posts[0].payload.b, 'Local-only test publication');
    assert.equal(posts.posts[0].eventId, post.event.id);
    const stored = relay.events.find((event) => event.id === post.event.id);
    assert.ok(stored, 'published post must reach the local relay');
    assert.equal(stored.pubkey, post.event.pubkey);
    assert.equal(verifyEvent(stored), true);
    assert.equal(post.authorPubkeyHex, signer.pubkeyHex);
    const payload = posts.posts[0].payload;
    assert.equal(payload.p, signer.pubkeyHex);
    // Forum transport uses an ephemeral outer key; the author signs the inner event.
    const inner = { kind: 21423, created_at: payload.ts, content: payload.w, tags: [] as string[][],
      pubkey: payload.p, sig: payload.sig, id: '' };
    inner.id = getEventHash(inner);
    assert.equal(verifyEvent(inner), true);
    assert.ok(relay.events.some((event) => event.kind === 24133), 'NIP46 requests/responses must cross the local relay');
    for (const event of relay.events) assert.equal(verifyEvent(event), true);
    await artifact('published-local-post.json', stored);

    const disconnected = await json('signer', 'disconnect');
    assert.equal(disconnected.connected, false);
    await assert.rejects(access(state));
    assert.equal((await json('signer', 'status')).connected, false);
  } finally {
    await signer.close();
    await relay.close();
  }
});
