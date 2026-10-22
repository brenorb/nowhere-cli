import type { Command } from 'commander';

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
