import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { describeSecret, generateSecretMaterial, type SecretMaterial } from './keys.js';

const SESSION_SECRET_ENV = 'NOWHERE_FORUM_SESSION_SECRET';
const SESSION_FILE = 'forum-session.json';

interface PersistedForumSession {
  secretHex: string;
}

export function getForumSessionPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(configHome, 'nowhere-cli', SESSION_FILE);
}

async function readPersistedForumSession(path: string): Promise<PersistedForumSession | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.secretHex !== 'string') {
      throw new Error('Missing secretHex.');
    }

    return { secretHex: describeSecret(parsed.secretHex).secretHex };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read the persisted forum session at ${path}: ${message}`, {
      cause: error,
    });
  }
}

async function writePersistedForumSession(path: string, session: PersistedForumSession): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export async function getForumSessionMaterial(): Promise<SecretMaterial> {
  const envSecret = process.env[SESSION_SECRET_ENV]?.trim();
  if (envSecret) {
    return describeSecret(envSecret);
  }

  const sessionPath = getForumSessionPath();
  const persisted = await readPersistedForumSession(sessionPath);
  if (persisted) {
    return describeSecret(persisted.secretHex);
  }

  const material = generateSecretMaterial();
  await writePersistedForumSession(sessionPath, { secretHex: material.secretHex });
  return material;
}
