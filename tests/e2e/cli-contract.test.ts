import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
function run(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('CLI conventions', () => {
  test('bare invocation succeeds with discoverable examples and support links', async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Examples:');
    expect(result.stdout).toContain('github.com/brenorb/nowhere-cli/issues');
  });

  test.each([
    ['create', 'message', '--unknown', '--help'],
    ['pubkey', '--secret', '--help'],
    ['forum', 'post', '--input', '--help'],
  ])('help takes priority over validation: %j', async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('github.com/brenorb/nowhere-cli');
  });

  test('unknown flags are reported as flags rather than decoded as fragments', async () => {
    const result = await run(['inspect', '--jsno']);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown option '--jsno'");
  });

  test('human output uses labels while explicit JSON remains parseable', async () => {
    const human = await run(['keygen']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Secret Hex:');
    expect(human.stdout.trim()).not.toMatch(/^\{/);
    const json = await run(['keygen', '--json']);
    expect(json.stderr).toBe('');
    expect(JSON.parse(json.stdout).secretHex).toMatch(/^[a-f0-9]{64}$/);
  });

  test('malformed JSON reports the input source without leaking its contents', async () => {
    const result = await run(['create', 'message', '--input', '-', '--json'], '{"private note": secret');
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid JSON from stdin');
    expect(result.stderr).not.toContain('private note');
  });
});
