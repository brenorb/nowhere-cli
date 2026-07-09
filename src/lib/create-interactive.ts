import { stderr as output } from 'node:process';
import type { CliSigner } from './active-signer.js';
import { promptToolFields } from './create-field-prompts.js';
import {
  buildCreatePayloadFromOptions,
  validateCreateCommandOptions,
  type CreateCommandOptions,
} from './create-long-form.js';
import { createPromptSession, promptYesNo, type PromptSession } from './create-prompt-session.js';
import {
  toolChoices,
  validateCreatePayloadRequirements,
  type ToolSlug,
} from './create-tools.js';

function fail(message: string): never {
  throw new Error(message);
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

function printSummary(tool: ToolSlug, payload: Record<string, unknown>): void {
  output.write(`\nCreate ${tool} with:\n`);
  output.write(`${JSON.stringify(payload, null, 2)}\n\n`);
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
