import { stderr as output, stdin as input } from 'node:process';
import { createInterface } from 'node:readline/promises';

export type PromptSession = {
  question(prompt: string): Promise<string>;
  close(): void;
};

export async function promptLine(
  session: PromptSession,
  label: string,
  options: { required?: boolean; allowBlank?: boolean } = {},
): Promise<string> {
  while (true) {
    const answer = (await session.question(`${label}: `)).trim();
    if (answer || options.allowBlank) {
      return answer;
    }
    if (!options.required) {
      return answer;
    }
    output.write('This field is required.\n');
  }
}

export async function promptYesNo(
  session: PromptSession,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';

  while (true) {
    const answer = (await session.question(`${label} ${suffix}: `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (answer === 'y' || answer === 'yes') {
      return true;
    }
    if (answer === 'n' || answer === 'no') {
      return false;
    }
    output.write('Enter y or n.\n');
  }
}

export async function createPromptSession(): Promise<PromptSession> {
  if (input.isTTY) {
    const rl = createInterface({ input, output });
    return {
      question(prompt: string) {
        return rl.question(prompt);
      },
      close() {
        rl.close();
      },
    };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const scriptedAnswers = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);

  return {
    async question(prompt: string) {
      output.write(prompt);
      return scriptedAnswers.shift() ?? '';
    },
    close() {},
  };
}
