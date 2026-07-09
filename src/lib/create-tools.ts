export type ToolSlug =
  | 'store'
  | 'event'
  | 'fundraiser'
  | 'petition'
  | 'message'
  | 'drop'
  | 'art'
  | 'forum';

export type CreateTextFieldKey = 'name' | 'description' | 'image' | 'pubkey' | 'svg';

export type CreatePromptStep =
  | {
      kind: 'text';
      key: CreateTextFieldKey;
      label: string;
      required: boolean;
    }
  | {
      kind: 'message-content';
    }
  | {
      kind: 'items';
    }
  | {
      kind: 'tags';
    };

export interface CreateToolDefinition {
  tool: ToolSlug;
  promptSteps: readonly CreatePromptStep[];
  supportsTitleFlag: boolean;
  supportsItemsFlag: boolean;
  supportsSvgField: boolean;
  requiresOwnerPubkey: boolean;
}

type CreatePayload = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

export function payloadHasMessageTitle(payload: CreatePayload): boolean {
  if (!Array.isArray(payload.tags)) {
    return false;
  }

  return payload.tags.some((entry) => (
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && 'key' in entry
    && 'value' in entry
    && (entry as { key?: unknown }).key === 't'
    && typeof (entry as { value?: unknown }).value === 'string'
    && Boolean((entry as { value: string }).value.trim())
  ));
}

export function validateCreatePayloadRequirements(tool: ToolSlug, payload: CreatePayload): void {
  const definition = getCreateToolDefinition(tool);

  for (const step of definition.promptSteps) {
    if (step.kind === 'text' && step.required && !hasValue(payload[step.key])) {
      fail(`${capitalize(step.label)} is required for ${tool} creation.`);
    }
    if (step.kind === 'items') {
      if (!Array.isArray(payload.items) || payload.items.length === 0) {
        fail('Store creation requires at least one item.');
      }
    }
    if (step.kind === 'message-content') {
      if (!hasValue(payload.description) && !payloadHasMessageTitle(payload)) {
        fail('Message requires either a description body or a non-empty "t" title tag.');
      }
    }
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const createToolDefinitions: Record<ToolSlug, CreateToolDefinition> = {
  store: {
    tool: 'store',
    supportsTitleFlag: false,
    supportsItemsFlag: true,
    supportsSvgField: false,
    requiresOwnerPubkey: true,
    promptSteps: [
      { kind: 'text', key: 'name', label: 'site name', required: true },
      { kind: 'text', key: 'description', label: 'description', required: false },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'owner pubkey', required: true },
      { kind: 'items' },
      { kind: 'tags' },
    ],
  },
  event: {
    tool: 'event',
    supportsTitleFlag: false,
    supportsItemsFlag: false,
    supportsSvgField: false,
    requiresOwnerPubkey: false,
    promptSteps: [
      { kind: 'text', key: 'name', label: 'site name', required: true },
      { kind: 'text', key: 'description', label: 'description', required: false },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'pubkey', required: false },
      { kind: 'tags' },
    ],
  },
  fundraiser: {
    tool: 'fundraiser',
    supportsTitleFlag: false,
    supportsItemsFlag: false,
    supportsSvgField: false,
    requiresOwnerPubkey: false,
    promptSteps: [
      { kind: 'text', key: 'name', label: 'site name', required: true },
      { kind: 'text', key: 'description', label: 'description', required: false },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'pubkey', required: false },
      { kind: 'tags' },
    ],
  },
  petition: {
    tool: 'petition',
    supportsTitleFlag: false,
    supportsItemsFlag: false,
    supportsSvgField: false,
    requiresOwnerPubkey: true,
    promptSteps: [
      { kind: 'text', key: 'name', label: 'site name', required: true },
      { kind: 'text', key: 'description', label: 'description', required: false },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'owner pubkey', required: true },
      { kind: 'tags' },
    ],
  },
  message: {
    tool: 'message',
    supportsTitleFlag: true,
    supportsItemsFlag: false,
    supportsSvgField: false,
    requiresOwnerPubkey: false,
    promptSteps: [
      { kind: 'text', key: 'name', label: 'message name', required: false },
      { kind: 'message-content' },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'author pubkey', required: false },
      { kind: 'tags' },
    ],
  },
  drop: {
    tool: 'drop',
    supportsTitleFlag: false,
    supportsItemsFlag: false,
    supportsSvgField: false,
    requiresOwnerPubkey: false,
    promptSteps: [
      { kind: 'text', key: 'name', label: 'site name', required: true },
      { kind: 'text', key: 'description', label: 'description', required: true },
      { kind: 'text', key: 'pubkey', label: 'pubkey', required: false },
      { kind: 'tags' },
    ],
  },
  art: {
    tool: 'art',
    supportsTitleFlag: false,
    supportsItemsFlag: false,
    supportsSvgField: true,
    requiresOwnerPubkey: false,
    promptSteps: [
      { kind: 'text', key: 'name', label: 'site name', required: true },
      { kind: 'text', key: 'pubkey', label: 'pubkey', required: false },
      { kind: 'text', key: 'svg', label: 'SVG markup', required: true },
      { kind: 'tags' },
    ],
  },
  forum: {
    tool: 'forum',
    supportsTitleFlag: false,
    supportsItemsFlag: false,
    supportsSvgField: false,
    requiresOwnerPubkey: true,
    promptSteps: [
      { kind: 'text', key: 'name', label: 'site name', required: true },
      { kind: 'text', key: 'description', label: 'description', required: false },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'owner pubkey', required: true },
      { kind: 'tags' },
    ],
  },
};

export const toolChoices = Object.freeze(Object.keys(createToolDefinitions) as ToolSlug[]);

export function getCreateToolDefinition(tool: ToolSlug): CreateToolDefinition {
  return createToolDefinitions[tool];
}

export function toolRequiresOwnerPubkey(tool: ToolSlug): boolean {
  return getCreateToolDefinition(tool).requiresOwnerPubkey;
}

export function toolSupportsItems(tool: ToolSlug): boolean {
  return getCreateToolDefinition(tool).supportsItemsFlag;
}

export function toolSupportsSvg(tool: ToolSlug): boolean {
  return getCreateToolDefinition(tool).supportsSvgField;
}

export function toolSupportsTitle(tool: ToolSlug): boolean {
  return getCreateToolDefinition(tool).supportsTitleFlag;
}
