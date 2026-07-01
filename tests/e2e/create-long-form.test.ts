import { describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateSecretMaterial } from '../../src/lib/keys.js';

const execFileAsync = promisify(execFile);
const cwd = '/Users/REDACTED';

async function cli(...args: string[]) {
  const result = await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], { cwd });
  return JSON.parse(result.stdout);
}

async function cliFailure(...args: string[]) {
  try {
    await execFileAsync('pnpm', ['tsx', 'src/cli.ts', ...args], { cwd });
    throw new Error('Expected the CLI command to fail.');
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
    return stderr;
  }
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

async function withTextFile(name: string, content: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'nowhere-cli-'));
  const file = join(dir, name);
  await writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('long-form create command', () => {
  test('builds a drop from explicit flags without a JSON file', async () => {
    const created = await cli(
      'create',
      'drop',
      '--name',
      'Field Notes',
      '--description',
      'Line one\nLine two',
      '--tag',
      't=release',
      '--json',
    );
    const inspected = await cli('inspect', created.fragment, '--json');

    expect(inspected.site.siteType).toBe('drop');
    expect(inspected.site.name).toBe('Field Notes');
    expect(created.siteData.tags).toEqual([{ key: 't', value: 'release' }]);
  });

  test('reads SVG markup for art sites from a file', async () => {
    await withTextFile(
      'stencil.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
      async (svgPath) => {
        const created = await cli(
          'create',
          'art',
          '--name',
          'Stencil',
          '--svg-file',
          svgPath,
          '--json',
        );

        expect(created.siteData.svg).toContain('<circle');
      },
    );
  });

  test('preserves store items and infers the owner pubkey from the signing secret', async () => {
    const seller = generateSecretMaterial();

    const created = await cli(
      'create',
      'store',
      '--name',
      'Freedom Market',
      '--description',
      'Sample store',
      '--item',
      'name=Sticker Pack;price=7.5;tag=f',
      '--item',
      'name=Zine;price=12;description=Printed field notes.',
      '--sign-secret',
      seller.nsec,
      '--json',
    );
    const verified = await cli('verify', created.fragment, '--json');

    expect(created.signed).toBe(true);
    expect(created.siteData.pubkey).toBe(seller.nowherePubkey);
    expect(created.siteData.items).toHaveLength(2);
    expect(created.siteData.items[0]).toMatchObject({
      name: 'Sticker Pack',
      price: 7.5,
      tags: [{ key: 'f' }],
    });
    expect(created.siteData.items[1]).toMatchObject({
      name: 'Zine',
      price: 12,
      description: 'Printed field notes.',
    });
    expect(verified.signed).toBe(true);
  });

  test('rejects mixing JSON input with long-form builder flags', async () => {
    await withJsonFile({ name: 'Field Notes', description: 'Line one' }, async (path) => {
      const stderr = await cliFailure(
        'create',
        'drop',
        '--input',
        path,
        '--name',
        'Override',
        '--json',
      );

      expect(stderr).toContain('Choose either --input <path> or long-form builder flags, not both.');
    });
  });
});
