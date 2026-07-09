import { readFile } from 'node:fs/promises';
import { nip19 } from 'nostr-tools';
import type { CliSigner } from './active-signer.js';
import {
  toolRequiresOwnerPubkey,
  toolSupportsItems,
  toolSupportsSvg,
  toolSupportsTitle,
  validateCreatePayloadRequirements,
  type ToolSlug,
} from './create-tools.js';
import { readJsonInput } from './io.js';

export interface CreateCommandOptions {
  input?: string;
  interactive?: boolean;
  name?: string;
  title?: string;
  description?: string;
  descriptionFile?: string;
  image?: string;
  pubkey?: string;
  tag?: string[];
  item?: string[];
  svg?: string;
  svgFile?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

async function readTextInput(path: string): Promise<string> {
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(path, 'utf8');
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(message);
  }

  return value as Record<string, unknown>;
}

export function parseTagSpec(spec: string): { key: string; value?: string } {
  const trimmed = spec.trim();
  if (!trimmed) {
    fail('Tag specs cannot be empty.');
  }

  const delimiterIndex = trimmed.indexOf('=');
  if (delimiterIndex < 0) {
    return { key: trimmed };
  }

  const key = trimmed.slice(0, delimiterIndex).trim();
  if (!key) {
    fail(`Invalid tag spec "${spec}". Expected KEY or KEY=VALUE.`);
  }

  return {
    key,
    value: trimmed.slice(delimiterIndex + 1),
  };
}

function splitEscapedSegments(value: string, delimiter: string): string[] {
  const segments: string[] = [];
  let current = '';
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    if (character === delimiter) {
      const segment = current.trim();
      if (segment) {
        segments.push(segment);
      }
      current = '';
      continue;
    }

    current += character;
  }

  if (escaped) {
    current += '\\';
  }

  const trailing = current.trim();
  if (trailing) {
    segments.push(trailing);
  }
  return segments;
}

export function parseStoreItemSpec(spec: string): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  const tags: Array<{ key: string; value?: string }> = [];

  for (const segment of splitEscapedSegments(spec, ';')) {
    const delimiterIndex = segment.indexOf('=');
    if (delimiterIndex < 0) {
      fail(
        `Invalid store item spec "${spec}". Use semicolon-separated key=value fields like "name=Sticker Pack;price=7.5;tag=f".`,
      );
    }

    const field = segment.slice(0, delimiterIndex).trim();
    const rawValue = segment.slice(delimiterIndex + 1);

    switch (field) {
      case 'name':
        item.name = rawValue;
        break;
      case 'price': {
        const price = Number(rawValue);
        if (!Number.isFinite(price)) {
          fail(`Invalid store item price "${rawValue}" in "${spec}".`);
        }
        item.price = price;
        break;
      }
      case 'description':
        item.description = rawValue;
        break;
      case 'image':
        item.image = rawValue;
        break;
      case 'tag':
        tags.push(parseTagSpec(rawValue));
        break;
      default:
        fail(
          `Unsupported store item field "${field}" in "${spec}". Use name, price, description, image, or tag.`,
        );
    }
  }

  if (typeof item.name !== 'string' || !item.name.trim()) {
    fail(`Store item specs must include a non-empty name: "${spec}".`);
  }
  if (typeof item.price !== 'number' || !Number.isFinite(item.price)) {
    fail(`Store item specs must include a numeric price: "${spec}".`);
  }
  if (tags.length > 0) {
    item.tags = tags;
  }

  return item;
}

export function hasLongFormCreateOptions(options: CreateCommandOptions): boolean {
  return (
    options.name !== undefined
    || options.title !== undefined
    || options.description !== undefined
    || options.descriptionFile !== undefined
    || options.image !== undefined
    || options.pubkey !== undefined
    || options.svg !== undefined
    || options.svgFile !== undefined
    || Boolean(options.tag && options.tag.length > 0)
    || Boolean(options.item && options.item.length > 0)
  );
}

export function upsertMessageTitleTag(payload: Record<string, unknown>, title: string): void {
  const existingTags = Array.isArray(payload.tags) ? payload.tags as Array<{ key?: unknown; value?: unknown }> : [];
  if (existingTags.some((tag) => tag.key === 't' && typeof tag.value === 'string' && tag.value.trim())) {
    fail('Choose either --title or a "t" tag, not both.');
  }

  payload.tags = [{ key: 't', value: title }, ...existingTags];
}

function validateToolSpecificFlags(tool: ToolSlug | undefined, options: CreateCommandOptions): void {
  if (!tool) {
    return;
  }

  if (!toolSupportsItems(tool) && options.item && options.item.length > 0) {
    fail('--item is only supported for store creation.');
  }
  if (!toolSupportsSvg(tool) && (options.svg !== undefined || options.svgFile !== undefined)) {
    fail('--svg and --svg-file are only supported for art creation.');
  }
  if (!toolSupportsTitle(tool) && options.title !== undefined) {
    fail('--title is only supported for message creation.');
  }
}

export function validateCreateCommandOptions(
  tool: ToolSlug | undefined,
  options: CreateCommandOptions,
  mode: 'interactive' | 'non-interactive',
): void {
  const usingInput = typeof options.input === 'string';
  const usingLongForm = hasLongFormCreateOptions(options);
  const usingInteractive = options.interactive === true;

  if (usingInput && usingLongForm) {
    fail('Choose either --input <path> or long-form builder flags, not both.');
  }
  if (usingInput && usingInteractive) {
    fail('Choose either --input <path> or --interactive, not both.');
  }
  if (mode === 'non-interactive' && !usingInput && !usingLongForm) {
    fail('Pass --input <path> or provide long-form builder flags like --name, --tag, and --item.');
  }
  if (options.description !== undefined && options.descriptionFile !== undefined) {
    fail('Choose either --description or --description-file, not both.');
  }
  if (options.svg !== undefined && options.svgFile !== undefined) {
    fail('Choose either --svg or --svg-file, not both.');
  }
  validateToolSpecificFlags(tool, options);
}

export async function buildCreatePayloadFromOptions(
  tool: ToolSlug,
  options: CreateCommandOptions,
  signer: CliSigner | undefined,
): Promise<Record<string, unknown>> {
  validateToolSpecificFlags(tool, options);

  const payload: Record<string, unknown> = {};

  if (options.name !== undefined) {
    payload.name = options.name;
  }
  if (options.image !== undefined) {
    payload.image = options.image;
  }
  if (options.pubkey !== undefined) {
    payload.pubkey = options.pubkey;
  }

  if (options.description !== undefined) {
    payload.description = options.description;
  } else if (options.descriptionFile !== undefined) {
    payload.description = await readTextInput(options.descriptionFile);
  }

  if (options.svg !== undefined) {
    payload.svg = options.svg;
  } else if (options.svgFile !== undefined) {
    payload.svg = await readTextInput(options.svgFile);
  }

  if (options.tag && options.tag.length > 0) {
    payload.tags = options.tag.map((spec) => parseTagSpec(spec));
  }
  if (options.title !== undefined) {
    upsertMessageTitleTag(payload, options.title);
  }

  if (options.item && options.item.length > 0) {
    payload.items = options.item.map((spec) => parseStoreItemSpec(spec));
  }

  if (
    signer
    && toolRequiresOwnerPubkey(tool)
    && (payload.pubkey === undefined || payload.pubkey === null || payload.pubkey === '')
  ) {
    payload.pubkey = nip19.npubEncode(await signer.getPublicKey());
  }

  return payload;
}

export async function resolveCreateRawInput(
  tool: ToolSlug,
  options: CreateCommandOptions,
  signer: CliSigner | undefined,
): Promise<unknown> {
  validateCreateCommandOptions(tool, options, 'non-interactive');

  if (typeof options.input === 'string') {
    const payload = requireObject(
      await readJsonInput(options.input),
      'Expected create input to be a JSON object or long-form builder fields.',
    );
    validateCreatePayloadRequirements(tool, payload);
    return payload;
  }

  const payload = await buildCreatePayloadFromOptions(tool, options, signer);
  validateCreatePayloadRequirements(tool, payload);
  return payload;
}
