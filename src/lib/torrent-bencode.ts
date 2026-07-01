import { createHash } from 'node:crypto';

const decoder = new TextDecoder('utf-8', { fatal: false });

type BValue = string | number | BValue[] | { [key: string]: BValue };

function parseValue(bytes: Uint8Array, position: number): [BValue, number] {
  const current = bytes[position];

  if (current === 0x69) {
    let end = position + 1;
    while (bytes[end] !== 0x65) {
      end += 1;
    }
    return [Number(decoder.decode(bytes.subarray(position + 1, end))), end + 1];
  }

  if (current === 0x6c) {
    const values: BValue[] = [];
    let next = position + 1;
    while (bytes[next] !== 0x65) {
      const [value, end] = parseValue(bytes, next);
      values.push(value);
      next = end;
    }
    return [values, next + 1];
  }

  if (current === 0x64) {
    const dict: { [key: string]: BValue } = {};
    let next = position + 1;
    while (bytes[next] !== 0x65) {
      const [key, keyEnd] = parseValue(bytes, next);
      const [value, valueEnd] = parseValue(bytes, keyEnd);
      dict[key as string] = value;
      next = valueEnd;
    }
    return [dict, next + 1];
  }

  let colon = position;
  while (bytes[colon] !== 0x3a) {
    colon += 1;
  }
  const length = Number(decoder.decode(bytes.subarray(position, colon)));
  const start = colon + 1;
  return [decoder.decode(bytes.subarray(start, start + length)), start + length];
}

function extractInfoBytes(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0x64) {
    throw new Error('torrent: root is not a dict');
  }
  let position = 1;
  while (position < bytes.length && bytes[position] !== 0x65) {
    const [key, keyEnd] = parseValue(bytes, position);
    const valueStart = keyEnd;
    const [, valueEnd] = parseValue(bytes, valueStart);
    if (key === 'info') {
      return bytes.subarray(valueStart, valueEnd);
    }
    position = valueEnd;
  }
  throw new Error('torrent: info dict not found');
}

function joinPath(parts: BValue[]): string {
  return (parts as string[]).join('/');
}

export interface ParsedTorrentFile {
  infohash: string;
  title: string;
  files: { path: string; size: number }[];
  trackers: string[];
}

export function parseTorrentFile(bytes: Uint8Array): ParsedTorrentFile {
  const [root] = parseValue(bytes, 0);
  const torrent = root as { [key: string]: BValue };
  const info = torrent.info as { [key: string]: BValue } | undefined;
  if (!info) {
    throw new Error('torrent: missing info dict');
  }

  const infohash = createHash('sha1').update(extractInfoBytes(bytes)).digest('hex');
  const title = typeof info.name === 'string' ? info.name : 'Unknown';

  let files: { path: string; size: number }[] = [];
  if (Array.isArray(info.files)) {
    for (const entry of info.files as Array<{ [key: string]: BValue }>) {
      const pathParts = Array.isArray(entry.path) ? entry.path : [];
      files.push({
        path: joinPath(pathParts),
        size: typeof entry.length === 'number' ? entry.length : 0,
      });
    }
  } else {
    files = [{
      path: title,
      size: typeof info.length === 'number' ? info.length : 0,
    }];
  }

  const maxFiles = 100;
  if (files.length > maxFiles) {
    const kept = files.slice(0, maxFiles);
    const rest = files.slice(maxFiles);
    const restSize = rest.reduce((sum, file) => sum + file.size, 0);
    kept.push({ path: `+ ${rest.length} more files`, size: restSize });
    files = kept;
  }

  const seen = new Set<string>();
  const trackers: string[] = [];
  const addTracker = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0 && !seen.has(value)) {
      seen.add(value);
      trackers.push(value);
    }
  };

  addTracker(torrent.announce);
  if (Array.isArray(torrent['announce-list'])) {
    for (const tier of torrent['announce-list'] as BValue[][]) {
      if (Array.isArray(tier)) {
        for (const tracker of tier) {
          addTracker(tracker);
        }
      }
    }
  }

  return { infohash, title, files, trackers };
}
