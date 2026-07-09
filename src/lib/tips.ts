export interface TipMethod {
  type: 'lightning' | 'custom';
  label: string;
  value: string;
  showQr?: boolean;
}

function unescapeField(value: string): string {
  return value.replace(/\\([\s\S])/g, '$1');
}

function indexOfUnescaped(value: string, delimiter: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1;
      continue;
    }
    if (value[index] === delimiter) {
      return index;
    }
  }
  return -1;
}

function splitUnescaped(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\' && index + 1 < value.length) {
      current += char + value[index + 1];
      index += 1;
    } else if (char === delimiter) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function escapeField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/:/g, '\\:');
}

export function parseTipMethods(raw: string): TipMethod[] {
  if (!raw) {
    return [];
  }

  return splitUnescaped(raw, ',')
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith('*')) {
        const rest = entry.slice(1);
        const showQr = rest.startsWith('!');
        const body = showQr ? rest.slice(1) : rest;
        const colonIndex = indexOfUnescaped(body, ':');
        if (colonIndex >= 0) {
          return {
            type: 'custom' as const,
            label: unescapeField(body.slice(0, colonIndex)),
            value: unescapeField(body.slice(colonIndex + 1)),
            showQr,
          };
        }
        return {
          type: 'custom' as const,
          label: unescapeField(body),
          value: '',
          showQr,
        };
      }

      return {
        type: 'lightning' as const,
        label: 'Lightning',
        value: unescapeField(entry),
      };
    });
}

export function serializeTipMethods(methods: TipMethod[]): string {
  return methods
    .map((method) => {
      if (method.type === 'custom') {
        return `*${method.showQr ? '!' : ''}${escapeField(method.label)}:${escapeField(method.value)}`;
      }
      return escapeField(method.value);
    })
    .join(',');
}
