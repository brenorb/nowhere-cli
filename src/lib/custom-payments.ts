export interface CustomPaymentMethod {
  label: string;
  currency: string;
  address: string;
  showQr: boolean;
}

function escapeField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\c').replace(/:/g, '\\o');
}

function unescapeField(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\' || index + 1 >= value.length) {
      result += value[index];
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === 'o') {
      result += ':';
    } else if (escaped === 'c') {
      result += ',';
    } else if (escaped === '\\') {
      result += '\\';
    } else {
      result += `\\${escaped}`;
    }
    index += 1;
  }
  return result;
}

function splitEntries(raw: string): string[] {
  const entries: string[] = [];
  let current = '';
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '\\' && index + 1 < raw.length) {
      current += raw[index] + raw[index + 1];
      index += 1;
    } else if (raw[index] === ',') {
      entries.push(current);
      current = '';
    } else {
      current += raw[index];
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

function splitColons(entry: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < entry.length; index += 1) {
    if (entry[index] === '\\' && index + 1 < entry.length) {
      current += entry[index] + entry[index + 1];
      index += 1;
    } else if (entry[index] === ':' && parts.length < 2) {
      parts.push(current);
      current = '';
    } else {
      current += entry[index];
    }
  }
  parts.push(current);
  return parts;
}

export function parseCustomPayments(raw: string): CustomPaymentMethod[] {
  if (!raw) {
    return [];
  }

  return splitEntries(raw)
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith('*')) {
        return null;
      }

      let rest = entry.slice(1);
      const showQr = rest.startsWith('!');
      if (showQr) {
        rest = rest.slice(1);
      }

      const parts = splitColons(rest);
      if (parts.length < 2) {
        return null;
      }

      return {
        label: unescapeField(parts[1] ?? ''),
        currency: unescapeField(parts[0] ?? '').toUpperCase(),
        address: unescapeField(parts[2] ?? ''),
        showQr,
      };
    })
    .filter((value): value is CustomPaymentMethod => value !== null);
}

export function serializeCustomPayments(methods: CustomPaymentMethod[]): string {
  return methods
    .map((method) => (
      `*${method.showQr ? '!' : ''}${escapeField(method.currency)}:${escapeField(method.label)}:${escapeField(method.address)}`
    ))
    .join(',');
}
