import { configHome } from './config.js';
import { writePrivateFile } from './private-files.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeSecret, generateSecretMaterial, type SecretMaterial } from './keys.js';

const SESSION_SECRET_ENV = 'NOWHERE_FORUM_SESSION_SECRET';
const SESSION_FILE = 'forum-session.json';

interface PersistedForumSession {
  secretHex: string;
}

export function getForumSessionPath(): string {
  return join(configHome(), 'nowhere-cli', SESSION_FILE);
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

    throw new Error(`Failed to read the persisted forum session at ${path}. Restore a backup or remove it to create a new identity.`, {
      cause: error,
    });
  }
}

async function writePersistedForumSession(path: string, session: PersistedForumSession): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(session, null, 2)}\n`);
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
