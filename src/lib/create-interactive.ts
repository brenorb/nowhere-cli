import { createInterface } from 'node:readline/promises';
import { stderr as output, stdin as input } from 'node:process';
import type { CliSigner } from './active-signer.js';
import {
  buildCreatePayloadFromOptions,
  parseStoreItemSpec,
  parseTagSpec,
  upsertMessageTitleTag,
  validateCreateCommandOptions,
  type CreateCommandOptions,
} from './create-long-form.js';
import {
  getCreateToolDefinition,
  payloadHasMessageTitle,
  toolChoices,
  validateCreatePayloadRequirements,
  type CreatePromptStep,
  type ToolSlug,
} from './create-tools.js';

type CreatePayload = Record<string, unknown>;
type CreateTag = { key: string; value?: string };
type CreateItem = Record<string, unknown>;
type PromptSession = {
  question(prompt: string): Promise<string>;
  close(): void;
};

function fail(message: string): never {
  throw new Error(message);
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

function readString(payload: CreatePayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readTags(payload: CreatePayload): CreateTag[] {
  return Array.isArray(payload.tags) ? payload.tags as CreateTag[] : [];
}

function setTags(payload: CreatePayload, tags: CreateTag[]): void {
  if (tags.length > 0) {
    payload.tags = tags;
    return;
  }
  delete payload.tags;
}

function readItems(payload: CreatePayload): CreateItem[] {
  return Array.isArray(payload.items) ? payload.items as CreateItem[] : [];
}

function setMessageTitle(payload: CreatePayload, title: string): void {
  upsertMessageTitleTag(payload, title);
}

async function promptLine(
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

async function promptYesNo(
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

async function promptTool(session: PromptSession): Promise<ToolSlug> {
  output.write(`Available tools: ${toolChoices.join(', ')}\n`);

  while (true) {
    const answer = (await session.question('Required: tool: ')).trim().toLowerCase();
    if (toolChoices.includes(answer as ToolSlug)) {
      return answer as ToolSlug;
    }
    output.write(`Pick one of: ${toolChoices.join(', ')}\n`);
  }
}

async function promptMissingText(
  session: PromptSession,
  payload: CreatePayload,
  key: string,
  label: string,
  required: boolean,
): Promise<void> {
  if (hasValue(payload[key])) {
    return;
  }

  const answer = await promptLine(
    session,
    `${required ? 'Required' : 'Optional'}: ${label}${required ? '' : ' (leave blank to skip)'}`,
    { required },
  );
  if (answer) {
    payload[key] = answer;
  }
}

async function promptMissingTags(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (readTags(payload).length > 0) {
    return;
  }

  output.write('Optional tags: enter KEY or KEY=VALUE. Leave blank to finish.\n');
  const tags: CreateTag[] = [];
  while (true) {
    const spec = await promptLine(session, 'Optional: tag', { allowBlank: true });
    if (!spec) {
      break;
    }
    tags.push(parseTagSpec(spec));
  }
  setTags(payload, tags);
}

async function promptStoreItems(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (readItems(payload).length > 0) {
    return;
  }

  const items: CreateItem[] = [];
  output.write('Required: add at least one store item.\n');

  while (true) {
    const name = await promptLine(session, 'Required: item name', { required: true });
    const price = await promptLine(session, 'Required: item price', { required: true });
    const description = await promptLine(session, 'Optional: item description (leave blank to skip)', { allowBlank: true });
    const image = await promptLine(session, 'Optional: item image URL (leave blank to skip)', { allowBlank: true });

    const itemSpecParts = [
      `name=${name}`,
      `price=${price}`,
      ...(description ? [`description=${description}`] : []),
      ...(image ? [`image=${image}`] : []),
    ];

    output.write('Optional item tags: enter KEY or KEY=VALUE. Leave blank to finish.\n');
    while (true) {
      const tag = await promptLine(session, 'Optional: item tag', { allowBlank: true });
      if (!tag) {
        break;
      }
      itemSpecParts.push(`tag=${tag}`);
    }

    items.push(parseStoreItemSpec(itemSpecParts.join(';')));
    if (!await promptYesNo(session, 'Add another item?', false)) {
      break;
    }
  }

  payload.items = items;
}

async function promptMessageFields(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (!readString(payload, 'description') && !payloadHasMessageTitle(payload)) {
    const body = await promptLine(session, 'Required: message body (leave blank to use a title instead)', { allowBlank: true });
    if (body) {
      payload.description = body;
    } else {
      const title = await promptLine(session, 'Required: message title', { required: true });
      setMessageTitle(payload, title);
    }
  } else if (!payloadHasMessageTitle(payload)) {
    const title = await promptLine(session, 'Optional: message title (leave blank to skip)', { allowBlank: true });
    if (title) {
      setMessageTitle(payload, title);
    }
  }
}

async function promptStep(session: PromptSession, payload: CreatePayload, step: CreatePromptStep): Promise<void> {
  if (step.kind === 'text') {
    await promptMissingText(session, payload, step.key, step.label, step.required);
    return;
  }
  if (step.kind === 'message-content') {
    await promptMessageFields(session, payload);
    return;
  }
  if (step.kind === 'items') {
    await promptStoreItems(session, payload);
    return;
  }
  await promptMissingTags(session, payload);
}

async function promptToolFields(session: PromptSession, tool: ToolSlug, payload: CreatePayload): Promise<void> {
  for (const step of getCreateToolDefinition(tool).promptSteps) {
    await promptStep(session, payload, step);
  }
}

function printSummary(tool: ToolSlug, payload: CreatePayload): void {
  output.write(`\nCreate ${tool} with:\n`);
  output.write(`${JSON.stringify(payload, null, 2)}\n\n`);
}

async function createPromptSession(): Promise<PromptSession> {
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

export async function resolveInteractiveCreateInput(
  requestedTool: string | undefined,
  options: CreateCommandOptions,
  signer: CliSigner | undefined,
): Promise<{ tool: ToolSlug; raw: Record<string, unknown> }> {
  validateCreateCommandOptions(undefined, options, 'interactive');

  const session = await createPromptSession();
  try {
    const tool = requestedTool ? requestedTool as ToolSlug : await promptTool(session);
    validateCreateCommandOptions(tool, options, 'interactive');

    const payload = await buildCreatePayloadFromOptions(tool, options, signer);
    await promptToolFields(session, tool, payload);
    validateCreatePayloadRequirements(tool, payload);
    printSummary(tool, payload);

    if (!await promptYesNo(session, 'Create site now?', true)) {
      fail('Create cancelled.');
    }

    return { tool, raw: payload };
  } finally {
    session.close();
  }
}
