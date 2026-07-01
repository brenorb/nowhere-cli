import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateSecretMaterial } from '../../src/lib/keys.js';

const execFileAsync = promisify(execFile);
const cwd = '/Users/breno/Documents/code/PROJECTS/HRF_GRANT/nowhere-cli';

async function cli(...args: string[]) {
  const result = await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], { cwd });
  return JSON.parse(result.stdout);
}

async function withJsonFile(payload: unknown, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nowhere-cli-'));
  const file = join(dir, 'input.json');
  await writeFile(file, JSON.stringify(payload, null, 2));
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('builder creation and update commands', () => {
  test.each([
    ['event', { name: 'Underground Gathering', tags: [{ key: 'T', value: 'g' }] }],
    ['fundraiser', { name: 'Legal Defense Fund', tags: [{ key: 'T', value: 'HRF' }] }],
    ['message', { name: 'Alice', description: 'Status update', tags: [{ key: 't', value: 'Dispatch' }] }],
    ['drop', { name: 'Field Notes', description: 'Line one\nLine two' }],
    ['art', { name: 'Stencil', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }],
  ])('create %s emits an inspectable site', async (tool, payload) => {
    await withJsonFile(payload, async (path) => {
      const created = await cli('create', tool, '--input', path, '--json');
      const inspected = await cli('inspect', created.fragment, '--json');

      expect(inspected.site.siteType).toBe(tool);
      expect(inspected.site.name).toBe(payload.name);
    });
  });

  test('create store preserves items and supports signing', async () => {
    const seller = generateSecretMaterial();
    const payload = {
      pubkey: seller.npub,
      name: 'Freedom Market',
      items: [
        { name: 'Sticker Pack', price: 7.5, tags: [{ key: 'f', value: null }] },
      ],
    };

    await withJsonFile(payload, async (path) => {
      const created = await cli('create', 'store', '--input', path, '--sign-secret', seller.nsec, '--json');
      const verified = await cli('verify', created.fragment, '--json');
      const inspected = await cli('inspect', created.unsignedFragment, '--json');

      expect(created.signed).toBe(true);
      expect(verified.signed).toBe(true);
      expect(inspected.site.siteType).toBe('store');
      expect(inspected.siteData?.items).toBeUndefined();
    });
  });

  test('create petition accepts a real key and can encrypt after signing', async () => {
    const owner = generateSecretMaterial();
    const payload = {
      pubkey: owner.pubkeyHex,
      name: 'Keep the Channel Open',
      tags: [{ key: 'N', value: null }, { key: 'R', value: null }],
    };

    await withJsonFile(payload, async (path) => {
      const created = await cli(
        'create',
        'petition',
        '--input',
        path,
        '--sign-secret',
        owner.secretHex,
        '--encrypt-password',
        'open sesame',
        '--json',
      );
      const decrypted = await cli('decrypt', created.url, '--password', 'open sesame', '--json');
      const verified = await cli('verify', decrypted.fragment, '--json');

      expect(created.encrypted).toBe(true);
      expect(verified.signed).toBe(true);
    });
  });

  test('create forum preserves boolean tags encoded through null values', async () => {
    const owner = generateSecretMaterial();
    const payload = {
      pubkey: owner.npub,
      name: 'Safe House',
      tags: [
        { key: 'i', value: '2' },
        { key: 'H', value: '1' },
        { key: 'V', value: null },
        { key: 'L', value: null },
      ],
    };

    await withJsonFile(payload, async (path) => {
      const created = await cli('create', 'forum', '--input', path, '--json');
      const inspected = await cli('inspect', created.fragment, '--json');

      expect(inspected.site.siteType).toBe('discussion');
      expect(inspected.site.name).toBe('Safe House');
    });
  });

  test('update imports an existing site, merges a patch, and republishes it', async () => {
    const payload = { name: 'Original Event', tags: [{ key: 'T', value: 'g' }] };
    const patch = { name: 'Updated Event', tags: [{ key: 'T', value: 'u' }, { key: 'o', value: 'Breno' }] };

    await withJsonFile(payload, async (createPath) => {
      const created = await cli('create', 'event', '--input', createPath, '--json');
      await withJsonFile(patch, async (patchPath) => {
        const updated = await cli('update', created.fragment, '--patch', patchPath, '--json');
        const inspected = await cli('inspect', updated.fragment, '--json');

        expect(inspected.site.name).toBe('Updated Event');
        expect(inspected.site.siteType).toBe('event');
      });
    });
  });
});
