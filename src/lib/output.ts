function label(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (value) => value.toUpperCase());
}

function formatValue(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return 'none';
  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty)';
    return `\n${value.map((entry) => `${indent}  - ${formatValue(entry, `${indent}  `)}`).join('\n')}`;
  }
  if (typeof value === 'object') {
    return `\n${Object.entries(value).map(([key, entry]) => `${indent}  ${label(key)}: ${formatValue(entry, `${indent}  `)}`).join('\n')}`;
  }
  return String(value);
}

export function printOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatValue(payload).trimStart()}\n`);
}
