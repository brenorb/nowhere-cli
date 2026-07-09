import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

interface PackageManifest {
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  license?: string;
  repository?: { type?: string; url?: string };
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
}

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest;
}

describe('npm release manifest', () => {
  test('is configured as an installable public CLI package', async () => {
    const manifest = await readManifest();

    expect(manifest.private).toBe(false);
    expect(manifest.bin).toEqual({ nowhere: 'dist/cli.js' });
    expect(manifest.files).toContain('dist');
    expect(manifest.license).toBe('AGPL-3.0-only');
    expect(manifest.publishConfig?.access).toBe('public');
    expect(manifest.repository?.url).toBe('git+https://github.com/project-maintainer/nowhere-cli.git');
    expect(Object.values(manifest.dependencies ?? {})).not.toContainEqual(expect.stringMatching(/^file:/));
  });
});
