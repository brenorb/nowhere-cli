import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

describe('documented agent workflows', () => {
  test('shell examples use protected sources for secrets', async () => {
    const documents = ['README.md', ...(await readdir(join(repository, 'docs')))
      .filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];
    for (const name of documents) {
      const source = await readFile(join(repository, name), 'utf8');
      const blocks = [...source.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)];
      for (const block of blocks) {
        expect(block[1], name).not.toMatch(/(?:^|\s)--(?:secret|sign-secret|password|encrypt-password|client-secret|session-secret|access-code|bunker|uri)\s/);
      }
    }
  });

  test('the documented Store example works offline with a separate key file', async () => {
    const source = await readFile(join(repository, 'docs/long-form-builder.md'), 'utf8');
    const example = [...source.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1]).find((block) => block.includes('pnpm cli create store'));
    expect(example).toBeDefined();
    // Tokenize the literal documented command; do not evaluate it in a shell.
    const args = (example ?? '').replace(/\\\n/g, ' ').match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
    expect(args.slice(0, 4)).toEqual(['pnpm', 'cli', 'create', 'store']);
    expect(args).toContain('--sign-secret-file');
    const directory = await mkdtemp(join(tmpdir(), 'nowhere-doc-example-'));
    const secret = '1'.repeat(64); // Disposable test key; never a user credential.
    try {
      const keyPath = args[args.indexOf('--sign-secret-file') + 1];
      expect(keyPath).toBe('./nostr-key');
      await writeFile(join(directory, 'nostr-key'), `${secret}\n`, { mode: 0o600 });
      const result = await execute(process.execPath,
        ['--import', tsxLoader, join(repository, 'src/cli.ts'), ...args.slice(2)], {
          cwd: directory, timeout: 10_000,
          env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config') },
        });
      expect(JSON.parse(result.stdout).url).toEqual(expect.any(String));
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
