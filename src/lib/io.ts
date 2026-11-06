import { readFile } from 'node:fs/promises';

function parseJson(raw: string, source: string): unknown {
  try { return JSON.parse(raw); } catch {
    throw new Error(`Invalid JSON from ${source}. Check the JSON syntax and retry.`);
  }
}

export async function readJsonInput(path: string): Promise<unknown> {
  if (path === '-') {
    if (process.stdin.isTTY) throw new Error('Expected JSON on stdin. Pipe JSON into the command or pass --input <path>.');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return parseJson(raw, 'stdin');
  }

  const raw = await readFile(path, 'utf8');
  return parseJson(raw, path);
}
