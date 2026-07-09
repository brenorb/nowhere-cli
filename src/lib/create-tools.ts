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

export interface CreatePromptChoice {
  label: string;
  value: string;
}

export interface CreateFieldStateDefinition {
  label: string;
  optionalKey: string;
  requiredKey: string;
}

export type CreateTagTextFormat =
  | 'plain'
  | 'cents'
  | 'integer'
  | 'datetime'
  | 'hex-color'
  | 'base36-integer'
  | 'dot-list'
  | 'escaped-list'
  | 'pipe-list';

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
    }
  | {
      kind: 'tag-text';
      tagKey: string;
      label: string;
      format?: CreateTagTextFormat;
      defaultTime?: string;
      whenTagPresent?: string;
    }
  | {
      kind: 'tag-choice';
      tagKey: string;
      label: string;
      choices: readonly CreatePromptChoice[];
      defaultValue: string;
      whenTagPresent?: string;
    }
  | {
      kind: 'tag-boolean';
      tagKey: string;
      label: string;
      defaultValue: boolean;
      valueWhenPresent: boolean;
      whenTagPresent?: string;
    }
  | {
      kind: 'tag-list';
      tagKey: string;
      label: string;
      itemLabel: string;
      maxItems?: number;
    }
  | {
      kind: 'tag-pairs';
      tagKey: string;
      label: string;
      firstLabel: string;
      secondLabel: string;
      format: 'lineup' | 'semicolon';
    }
  | {
      kind: 'field-states';
      fields: readonly CreateFieldStateDefinition[];
    }
  | {
      kind: 'contacts';
    }
  | {
      kind: 'tips';
    }
  | {
      kind: 'store-payments';
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

const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'BRL', 'MXN', 'BTC']
  .map((value) => ({ label: value === 'BTC' ? 'BTC (sats)' : value, value }));

const eventCurrencies = ['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'JPY', 'CHF', 'BTC', 'SATS']
  .map((value) => ({ label: value, value }));

const eventStyles: readonly CreatePromptChoice[] = [
  { label: 'Generic', value: 'g' },
  { label: 'Underground', value: 'u' },
  { label: 'Declaration', value: 'd' },
  { label: 'Warm', value: 'w' },
  { label: 'Refined', value: 'r' },
  { label: 'Monumental', value: 'm' },
  { label: 'Broadcast', value: 'b' },
];

const artThemes: readonly CreatePromptChoice[] = [
  { label: 'Gallery', value: 'g' },
  { label: 'Bleed', value: 'b' },
  { label: 'Border', value: 'r' },
  { label: 'Stamp', value: 's' },
  { label: 'Dark Room', value: 'd' },
  { label: 'Broadside', value: 'w' },
  { label: 'Manifesto', value: 'm' },
  { label: 'Paste-up', value: 'p' },
];

const forumDepths: readonly CreatePromptChoice[] = [
  { label: 'No limit', value: '' },
  { label: 'Creator only', value: '0' },
  { label: "Creator's follows", value: '1' },
  { label: '2 hops', value: '2' },
  { label: '3 hops', value: '3' },
];

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
      { kind: 'text', key: 'description', label: 'subtitle', required: false },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'owner pubkey', required: true },
      { kind: 'items' },
      { kind: 'tag-text', tagKey: 'b', label: 'description' },
      { kind: 'tag-choice', tagKey: '$', label: 'currency', choices: currencies, defaultValue: 'USD' },
      {
        kind: 'tag-choice',
        tagKey: 'w',
        label: 'weight unit',
        choices: [
          { label: 'Grams', value: 'g' },
          { label: 'Kilograms', value: 'kg' },
          { label: 'Pounds', value: 'lb' },
          { label: 'Ounces', value: 'oz' },
        ],
        defaultValue: 'g',
      },
      { kind: 'tag-text', tagKey: 'r', label: 'returns and refunds policy' },
      { kind: 'tag-text', tagKey: 'Y', label: 'warranty policy' },
      { kind: 'tag-text', tagKey: 'Q', label: 'FAQ' },
      { kind: 'tag-boolean', tagKey: 'G', label: 'suggest Nostr as a contact option', defaultValue: false, valueWhenPresent: true },
      { kind: 'tag-text', tagKey: 'I', label: 'contact email' },
      { kind: 'contacts' },
      { kind: 'store-payments' },
      {
        kind: 'field-states',
        fields: [
          { label: 'collect buyer email', optionalKey: 'e', requiredKey: 'E' },
          { label: 'collect buyer name', optionalKey: 'n', requiredKey: 'N' },
          { label: 'collect buyer address', optionalKey: 'a', requiredKey: 'A' },
          { label: 'collect buyer phone', optionalKey: 'p', requiredKey: 'P' },
          { label: 'collect buyer Nostr npub', optionalKey: 'z', requiredKey: 'Z' },
        ],
      },
      { kind: 'tag-text', tagKey: 'L', label: 'store country code' },
      { kind: 'tag-text', tagKey: 's', label: 'domestic flat rate', format: 'cents' },
      { kind: 'tag-text', tagKey: 'S', label: 'international flat rate', format: 'cents' },
      { kind: 'tag-text', tagKey: 'h', label: 'domestic per-weight surcharge', format: 'cents' },
      { kind: 'tag-text', tagKey: 'H', label: 'international per-weight surcharge', format: 'cents' },
      { kind: 'tag-text', tagKey: 'm', label: 'minimum order', format: 'cents' },
      { kind: 'tag-text', tagKey: 'B', label: 'buy-X discount (for example 2:10)' },
      { kind: 'tag-text', tagKey: 'X', label: 'maximum discount', format: 'cents' },
      { kind: 'tag-text', tagKey: 'D', label: 'delivery time in days' },
      { kind: 'tag-text', tagKey: 'c', label: 'allowed country codes', format: 'dot-list' },
      { kind: 'tag-text', tagKey: 'x', label: 'excluded country codes', format: 'dot-list' },
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
      { kind: 'text', key: 'description', label: 'tagline', required: false },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'pubkey', required: false },
      { kind: 'tag-choice', tagKey: 'T', label: 'style', choices: eventStyles, defaultValue: 'g' },
      { kind: 'tag-text', tagKey: 'C', label: 'accent colour', format: 'hex-color' },
      { kind: 'tag-text', tagKey: 'o', label: 'organiser' },
      { kind: 'tag-text', tagKey: 'D', label: 'start date and time', format: 'datetime', defaultTime: '19:00' },
      { kind: 'tag-text', tagKey: 'd', label: 'end date and time', format: 'datetime', defaultTime: '22:00' },
      { kind: 'tag-text', tagKey: 'L', label: 'venue' },
      { kind: 'tag-text', tagKey: 'l', label: 'address' },
      { kind: 'tag-text', tagKey: 'O', label: 'online or stream link' },
      { kind: 'tag-text', tagKey: 'b', label: 'event details' },
      { kind: 'tag-text', tagKey: '$', label: 'admission price', format: 'cents' },
      { kind: 'tag-choice', tagKey: 'K', label: 'admission currency', choices: eventCurrencies, defaultValue: '' },
      { kind: 'tag-text', tagKey: 'r', label: 'RSVP or ticket link' },
      {
        kind: 'tag-pairs',
        tagKey: 'P',
        label: 'lineup or speakers',
        firstLabel: 'name',
        secondLabel: 'role or subtitle',
        format: 'lineup',
      },
      { kind: 'tag-text', tagKey: 'A', label: 'schedule or agenda' },
      { kind: 'tag-text', tagKey: 'q', label: 'capacity', format: 'integer' },
      { kind: 'tag-text', tagKey: 'R', label: 'age restriction' },
      { kind: 'tag-text', tagKey: 'v', label: 'dress code' },
      { kind: 'tag-list', tagKey: '2', label: 'additional images', itemLabel: 'image URL', maxItems: 4 },
      { kind: 'tag-boolean', tagKey: 'G', label: 'suggest Nostr as a contact option', defaultValue: false, valueWhenPresent: true },
      { kind: 'tag-text', tagKey: 'I', label: 'contact email' },
      { kind: 'contacts' },
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
      { kind: 'text', key: 'description', label: 'the story', required: false },
      { kind: 'text', key: 'image', label: 'cover image URLs (space-separated)', required: false },
      { kind: 'text', key: 'pubkey', label: 'pubkey', required: false },
      { kind: 'tag-text', tagKey: 'T', label: 'campaign creator' },
      { kind: 'tag-choice', tagKey: '$', label: 'currency', choices: currencies, defaultValue: 'USD' },
      { kind: 'tag-text', tagKey: 'g', label: 'goal amount', format: 'cents' },
      { kind: 'tag-text', tagKey: 'h', label: 'deadline (YYYY-MM-DD)' },
      { kind: 'tag-text', tagKey: 't', label: 'tagline' },
      { kind: 'tag-text', tagKey: 'b', label: 'what the money is for' },
      { kind: 'tag-text', tagKey: 'Q', label: 'FAQ' },
      { kind: 'tips' },
      { kind: 'tag-boolean', tagKey: 'G', label: 'suggest Nostr as a contact option', defaultValue: false, valueWhenPresent: true },
      { kind: 'tag-text', tagKey: 'I', label: 'contact email' },
      { kind: 'contacts' },
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
      { kind: 'text', key: 'description', label: 'the statement', required: false },
      { kind: 'text', key: 'image', label: 'cover image URLs (space-separated)', required: false },
      { kind: 'text', key: 'pubkey', label: 'owner pubkey', required: true },
      { kind: 'tag-text', tagKey: 'T', label: 'organiser' },
      { kind: 'tag-text', tagKey: 'g', label: 'signature goal', format: 'integer' },
      { kind: 'tag-text', tagKey: 'h', label: 'deadline (YYYY-MM-DD)' },
      { kind: 'tag-text', tagKey: 't', label: 'tagline' },
      { kind: 'tag-text', tagKey: 'b', label: 'additional context' },
      {
        kind: 'tag-pairs',
        tagKey: 'D',
        label: 'decision makers',
        firstLabel: 'name',
        secondLabel: 'title',
        format: 'semicolon',
      },
      { kind: 'tag-boolean', tagKey: 'R', label: 'allow signer comments', defaultValue: false, valueWhenPresent: true },
      { kind: 'tag-text', tagKey: 'c', label: 'allowed signer country codes', format: 'dot-list' },
      {
        kind: 'field-states',
        fields: [
          { label: 'signer email', optionalKey: 'e', requiredKey: 'E' },
          { label: 'signer name', optionalKey: 'n', requiredKey: 'N' },
          { label: 'signer address', optionalKey: 'a', requiredKey: 'A' },
          { label: 'signer full address', optionalKey: 'b', requiredKey: 'B' },
          { label: 'signer phone', optionalKey: 'p', requiredKey: 'P' },
          { label: 'signer Nostr npub', optionalKey: 'z', requiredKey: 'Z' },
          { label: 'signer organisation', optionalKey: 'u', requiredKey: 'U' },
        ],
      },
      { kind: 'tag-boolean', tagKey: 'G', label: 'suggest Nostr as a contact option', defaultValue: false, valueWhenPresent: true },
      { kind: 'tag-text', tagKey: 'I', label: 'contact email' },
      { kind: 'contacts' },
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
      { kind: 'text', key: 'name', label: 'author name', required: true },
      { kind: 'message-content' },
      { kind: 'text', key: 'image', label: 'image URL', required: false },
      { kind: 'text', key: 'pubkey', label: 'author pubkey', required: false },
      { kind: 'tips' },
      { kind: 'tag-boolean', tagKey: 'G', label: 'suggest Nostr as a contact option', defaultValue: false, valueWhenPresent: true },
      { kind: 'tag-text', tagKey: 'I', label: 'contact email' },
      { kind: 'contacts' },
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
      { kind: 'tag-text', tagKey: 'A', label: 'attribution' },
      { kind: 'tag-choice', tagKey: 'T', label: 'frame', choices: artThemes, defaultValue: 'g' },
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
      { kind: 'tag-text', tagKey: 'O', label: 'topics (comma-separated)', format: 'escaped-list' },
      {
        kind: 'tag-choice',
        tagKey: 'i',
        label: 'identity mode',
        choices: [
          { label: 'Require extension (NIP-07)', value: '0' },
          { label: 'Allow both', value: '1' },
          { label: 'Ephemeral only', value: '2' },
        ],
        defaultValue: '1',
      },
      {
        kind: 'tag-choice',
        tagKey: 'H',
        label: 'privacy mode',
        choices: [
          { label: 'Full profile', value: '0' },
          { label: 'Private', value: '1' },
        ],
        defaultValue: '0',
      },
      { kind: 'tag-text', tagKey: 'm', label: 'post size limit', format: 'base36-integer' },
      { kind: 'tag-choice', tagKey: 'W', label: 'WoT depth for posts', choices: forumDepths, defaultValue: '' },
      { kind: 'tag-choice', tagKey: '3', label: 'WoT depth for replies', choices: forumDepths, defaultValue: '' },
      { kind: 'tag-choice', tagKey: '4', label: 'WoT depth for chat', choices: forumDepths, defaultValue: '' },
      { kind: 'tag-text', tagKey: 'X', label: 'banned words' },
      { kind: 'tag-boolean', tagKey: 'S', label: 'enable post sharing', defaultValue: true, valueWhenPresent: false },
      { kind: 'tag-boolean', tagKey: '9', label: 'enable QR sharing', defaultValue: true, valueWhenPresent: false },
      { kind: 'tag-boolean', tagKey: 'L', label: 'enable salt (censorship resistance)', defaultValue: false, valueWhenPresent: true },
      { kind: 'tag-boolean', tagKey: 'b', label: 'enable torrents', defaultValue: false, valueWhenPresent: true },
      { kind: 'tag-text', tagKey: 'q', label: 'torrent categories (comma-separated)', format: 'pipe-list', whenTagPresent: 'b' },
      { kind: 'tag-boolean', tagKey: 'F', label: 'lock torrent categories', defaultValue: false, valueWhenPresent: true, whenTagPresent: 'b' },
      { kind: 'tag-choice', tagKey: '5', label: 'WoT depth for torrent submitters', choices: forumDepths, defaultValue: '', whenTagPresent: 'b' },
      { kind: 'tag-text', tagKey: 'h', label: 'torrent rules', whenTagPresent: 'b' },
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
