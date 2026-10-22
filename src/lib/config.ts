import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export function configHome(): string {
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  return configured && isAbsolute(configured) ? configured : join(homedir(), '.config');
}
