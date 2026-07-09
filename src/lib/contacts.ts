export interface ContactPlatform {
  code: string;
  name: string;
}

export interface ContactEntry {
  code: string;
  handle: string;
  customName?: string;
}

export const CONTACT_PLATFORMS: readonly ContactPlatform[] = [
  { code: 'P', name: 'Phone Number' },
  { code: 'T', name: 'Telegram' },
  { code: 'S', name: 'Signal' },
  { code: 'W', name: 'WhatsApp' },
  { code: 'X', name: 'SimpleX' },
  { code: 'E', name: 'Session' },
  { code: 'H', name: 'Threema' },
  { code: 'D', name: 'Discord' },
  { code: 'M', name: 'Matrix' },
  { code: 'K', name: 'X / Twitter' },
  { code: 'I', name: 'Instagram' },
  { code: 'F', name: 'Facebook Messenger' },
  { code: 'C', name: 'WeChat' },
  { code: 'L', name: 'LINE' },
  { code: 'd', name: 'Delta Chat' },
  { code: '*', name: 'Custom' },
];

function escapeField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/:/g, '\\:');
}

function unescapeField(value: string): string {
  return value.replace(/\\([\s\S])/g, '$1');
}

function indexOfUnescaped(value: string, delimiter: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1;
    } else if (value[index] === delimiter) {
      return index;
    }
  }
  return -1;
}

function splitUnescaped(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) {
      current += character + value[index + 1];
      index += 1;
    } else if (character === delimiter) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts;
}

export function parseContacts(raw: string): ContactEntry[] {
  if (!raw) {
    return [];
  }
  return splitUnescaped(raw, ',')
    .filter(Boolean)
    .map((entry) => {
      const code = entry[0] ?? '';
      if (code !== '*') {
        return { code, handle: unescapeField(entry.slice(1)) };
      }
      const rest = entry.slice(1);
      const delimiterIndex = indexOfUnescaped(rest, ':');
      if (delimiterIndex < 0) {
        return { code, customName: unescapeField(rest), handle: '' };
      }
      return {
        code,
        customName: unescapeField(rest.slice(0, delimiterIndex)),
        handle: unescapeField(rest.slice(delimiterIndex + 1)),
      };
    });
}

export function serializeContacts(contacts: ContactEntry[]): string {
  return contacts
    .map((contact) => (
      contact.code === '*'
        ? `*${escapeField(contact.customName ?? '')}:${escapeField(contact.handle)}`
        : `${contact.code}${escapeField(contact.handle)}`
    ))
    .join(',');
}
