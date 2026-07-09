import { describe, expect, test } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateSecretMaterial } from '../../src/lib/keys.js';

const execFileAsync = promisify(execFile);
const cwd = '/Users/breno/Documents/code/PROJECTS/HRF_GRANT/nowhere-cli';
const cliArgs = ['--import', 'tsx', 'src/cli.ts'];

async function cli(...args: string[]) {
  const result = await execFileAsync('node', [...cliArgs, ...args], { cwd });
  return JSON.parse(result.stdout);
}

async function cliFailure(...args: string[]) {
  try {
    await execFileAsync('node', [...cliArgs, ...args], { cwd });
    throw new Error('Expected the CLI command to fail.');
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
    return stderr;
  }
}

async function cliInteractive(answers: string[], ...args: string[]) {
  const child = spawn('node', [...cliArgs, ...args], { cwd });

  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.stdin.write(`${answers.join('\n')}\n`);
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`Interactive CLI failed with code ${exitCode}: ${stderr}`);
  }

  return {
    json: JSON.parse(stdout),
    stderr,
  };
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

  test('supports a message title flag as sugar for the title tag', async () => {
    const created = await cli(
      'create',
      'message',
      '--name',
      'Alice',
      '--title',
      'Dispatch',
      '--json',
    );

    expect(created.siteData.name).toBe('Alice');
    expect(created.siteData.tags).toEqual([{ key: 't', value: 'Dispatch' }]);
  });

  test('message creation requires the author name used by the hosted builder', async () => {
    const stderr = await cliFailure(
      'create',
      'message',
      '--title',
      'Dispatch',
      '--json',
    );

    expect(stderr).toContain('Author name is required for message creation.');
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

  test('interactive mode fills only the missing fields for a chosen tool', async () => {
    const { json: created } = await cliInteractive(
      [
        'Line one',
        '',
        'V',
        '',
        'y',
      ],
      'create',
      'drop',
      '--interactive',
      '--name',
      'Field Notes',
      '--json',
    );
    const inspected = await cli('inspect', created.fragment, '--json');

    expect(inspected.site.siteType).toBe('drop');
    expect(inspected.site.name).toBe('Field Notes');
    expect(created.siteData.description).toBe('Line one');
    expect(created.siteData.tags).toEqual([{ key: 'V' }]);
  });

  test('interactive mode accepts pubkeys copied as nostr:npub URIs', async () => {
    const author = generateSecretMaterial();
    const { json: created } = await cliInteractive(
      [
        'Line one',
        `nostr:${author.npub}`,
        '',
        'y',
      ],
      'create',
      'drop',
      '--interactive',
      '--name',
      'Field Notes',
      '--json',
    );

    expect(created.siteData.pubkey).toBe(author.nowherePubkey);
  });

  test('interactive mode can prompt for the tool before collecting its fields', async () => {
    const { json: created } = await cliInteractive(
      [
        'message',
        'Alice',
        'Status update',
        '',
        '',
        '',
      ],
      'create',
      '--interactive',
      '--json',
    );
    const inspected = await cli('inspect', created.fragment, '--json');

    expect(inspected.site.siteType).toBe('message');
    expect(inspected.site.name).toBe('Alice');
    expect(created.siteData.description).toBe('Status update');
  });

  test('interactive event mode encodes hosted builder fields as canonical tags', async () => {
    const { json: created, stderr } = await cliInteractive(
      [
        '',
        '',
        '',
        'u',
        '#ff0099',
        'Nowhere',
        '2026-08-01',
        '20:30',
        '',
        'Warehouse',
        '',
        '',
        'Doors at 8',
        '12.50',
        'EUR',
        '',
        '',
        '',
        '120',
        '18+',
        '',
        '',
        'n',
        'events@example.com',
        'n',
        'y',
      ],
      'create',
      'event',
      '--interactive',
      '--name',
      'Night Market',
      '--json',
    );

    expect(stderr).toContain('Optional: style [Generic]');
    expect(created.siteData.tags).toEqual([
      { key: 'T', value: 'u' },
      { key: 'C', value: 'FF0099' },
      { key: 'o', value: 'Nowhere' },
      { key: 'D', value: '202608012030' },
      { key: 'L', value: 'Warehouse' },
      { key: 'b', value: 'Doors at 8' },
      { key: '$', value: '1250' },
      { key: 'K', value: 'EUR' },
      { key: 'q', value: '120' },
      { key: 'R', value: '18+' },
      { key: 'I', value: 'events@example.com' },
    ]);
  });

  test('interactive message mode collects hosted tip and contact methods', async () => {
    const { json: created, stderr } = await cliInteractive(
      [
        '',
        '',
        'tips@example.com',
        'y',
        'PIX',
        'pix-key',
        'y',
        'n',
        'y',
        'alice@example.com',
        'y',
        'Telegram',
        '@alice',
        '',
        'y',
      ],
      'create',
      'message',
      '--interactive',
      '--name',
      'Alice',
      '--title',
      'Dispatch',
      '--json',
    );

    expect(stderr).toContain('Optional: Lightning address');
    expect(stderr).toContain('Contact methods:');
    expect(created.siteData.tags).toEqual([
      { key: 't', value: 'Dispatch' },
      { key: 'l', value: 'tips@example.com,*!PIX:pix-key' },
      { key: 'G' },
      { key: 'I', value: 'alice@example.com' },
      { key: 'j', value: 'T@alice' },
    ]);
  });

  test('interactive store mode can collect repeated item entries', async () => {
    const seller = generateSecretMaterial();
    const { json: created } = await cliInteractive(
      [
        'Freedom Market',
        '',
        '',
        'Sticker Pack',
        '7.5',
        '',
        '',
        '',
        'n',
        '',
      ],
      'create',
      'store',
      '--interactive',
      '--sign-secret',
      seller.nsec,
      '--json',
    );

    expect(created.siteData.pubkey).toBe(seller.nowherePubkey);
    expect(created.siteData.items).toHaveLength(1);
    expect(created.siteData.items[0]).toMatchObject({
      name: 'Sticker Pack',
      price: 7.5,
    });
  });

  test('store creation fails clearly when no items are provided', async () => {
    const seller = generateSecretMaterial();
    const stderr = await cliFailure(
      'create',
      'store',
      '--name',
      'Freedom Market',
      '--sign-secret',
      seller.nsec,
      '--json',
    );

    expect(stderr).toContain('Store creation requires at least one item.');
  });

  test('drop creation fails clearly when the description is missing', async () => {
    const stderr = await cliFailure(
      'create',
      'drop',
      '--name',
      'Field Notes',
      '--json',
    );

    expect(stderr).toContain('Description is required for drop creation.');
  });

  test('art creation fails clearly when SVG markup is missing', async () => {
    const stderr = await cliFailure(
      'create',
      'art',
      '--name',
      'Stencil',
      '--json',
    );

    expect(stderr).toContain('SVG markup is required for art creation.');
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

  test('rejects mixing JSON input with interactive mode', async () => {
    await withJsonFile({ name: 'Field Notes', description: 'Line one' }, async (path) => {
      const stderr = await cliFailure(
        'create',
        'drop',
        '--input',
        path,
        '--interactive',
        '--json',
      );

      expect(stderr).toContain('Choose either --input <path> or --interactive, not both.');
    });
  });

  test('reports a clearer error for non-npub nostr identifiers in pubkey fields', async () => {
    const stderr = await cliFailure(
      'create',
      'drop',
      '--name',
      'Field Notes',
      '--description',
      'Line one',
      '--pubkey',
      'nostr:note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      '--json',
    );

    expect(stderr).toContain('Expected an npub public key, but received a different nostr identifier.');
  });
});
