import { readFile } from 'node:fs/promises';
import { InvalidArgumentError, type Command } from 'commander';

const docs = 'https://github.com/brenorb/nowhere-cli#readme';

export function configureHelp(command: Command): void {
  command.showHelpAfterError('(add --help for usage and examples)');
  command.addHelpText('after', `\nDocumentation: ${docs}\nSupport: https://github.com/brenorb/nowhere-cli/issues`);
  for (const child of command.commands) configureHelp(child);
}

// Resolve help before Commander validates required values or unknown options.
// The -- separator still protects literal arguments named --help.
export function requestedHelp(root: Command, args: string[]): Command | undefined {
  const tokens = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  if (!tokens.some((token) => token === '-h' || token === '--help')) return undefined;
  let command = root;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const child = command.commands.find((candidate) => candidate.name() === token || candidate.aliases().includes(token));
    if (child) { command = child; continue; }
    const option = command.options.find((candidate) => candidate.short === token || candidate.long === token);
    if (option?.required || option?.optional) index += 1;
  }
  return command;
}

const sensitiveOptions = new Set(['secret', 'sign-secret', 'password', 'encrypt-password', 'client-secret', 'session-secret', 'access-code', 'bunker', 'uri']);

export function configureSecretFiles(command: Command): void {
  for (const option of [...command.options]) {
    if (!sensitiveOptions.has(option.name())) continue;
    const required = option.mandatory;
    option.makeOptionMandatory(false);
    const fileFlag = `--${option.name()}-file`;
    command.option(`${fileFlag} <path>`, `Read ${option.long} from a UTF-8 file (avoids shell history and process listings).`);
    command.hook('preAction', async () => {
      const key = option.attributeName();
      const fileKey = `${key}File`;
      const values = command.opts();
      if (values[key] !== undefined && values[fileKey] !== undefined) {
        throw new Error(`Choose either ${option.long} or ${fileFlag}, not both.`);
      }
      if (values[fileKey] !== undefined) {
        let contents: string;
        try { contents = await readFile(values[fileKey], 'utf8'); } catch {
          throw new Error(`Cannot read ${fileFlag}. Check that the file exists and is readable.`);
        }
        contents = contents.replace(/\r?\n$/, '');
        if (!contents) throw new Error(`${fileFlag} must contain a non-empty value.`);
        command.setOptionValue(key, contents);
      }
      if (required && command.opts()[key] === undefined) {
        throw new Error(`Provide ${option.long} or ${fileFlag}. See --help for usage.`);
      }
    });
  }
  for (const child of command.commands) configureSecretFiles(child);
}

export function positiveSeconds(value: string): number {
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number) || number <= 0 || number > 2147483) {
    throw new InvalidArgumentError('must be a positive number of seconds (at most 2147483).');
  }
  return number;
}

export function configureNumericOptions(command: Command): void {
  const integers = new Set(['timeout-ms', 'since', 'until', 'limit', 'received-sats', 'pow-difficulty', 'min-bytes', 'max-bytes']);
  for (const option of command.options) {
    if (option.name() === 'watch-seconds') {
      option.argParser((value: string) => { positiveSeconds(value); return value; });
      continue;
    }
    if (!integers.has(option.name())) continue;
    option.argParser((value: string) => {
      const number = Number(value);
      const minimum = ['timeout-ms', 'limit'].includes(option.name()) ? 1 : 0;
      const maximum = option.name() === 'pow-difficulty' ? 32 : option.name() === 'timeout-ms' ? 2147483647 : Number.MAX_SAFE_INTEGER;
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new InvalidArgumentError(`must be an integer between ${minimum} and ${maximum}.`);
      }
      // Keep existing option value types, whose consumers parse validated strings.
      return option.name() === 'timeout-ms' ? number : value;
    });
  }
  for (const child of command.commands) configureNumericOptions(child);
}
