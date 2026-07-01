import { readFile } from 'node:fs/promises';

export async function readJsonInput(path: string): Promise<unknown> {
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return JSON.parse(raw);
  }

  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}
