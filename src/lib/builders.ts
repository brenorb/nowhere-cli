import {
  encode,
  encodeArt,
  encodeDrop,
  encodeEvent,
  encodeForum,
  encodeFundraiser,
  encodeMessage,
  encodePetition,
  type ArtData,
  type DropData,
  type EventData,
  type ForumData,
  type FundraiserData,
  type Item,
  type MessageData,
  type PetitionData,
  type SiteData,
  type StoreData,
  type Tag,
} from '@nowhere/codec';
import { computeVerificationSummary, fragmentToUrl } from './fragments.js';
import { normalizeNowherePubkey } from './keys.js';

export type ToolSlug =
  | 'store'
  | 'event'
  | 'fundraiser'
  | 'petition'
  | 'message'
  | 'drop'
  | 'art'
  | 'forum';

type EncodableSite =
  | StoreData
  | EventData
  | FundraiserData
  | PetitionData
  | MessageData
  | DropData
  | ArtData
  | ForumData;

export interface BuiltSiteResult {
  tool: ToolSlug;
  siteData: EncodableSite;
  fragment: string;
  url: string;
  verification: Awaited<ReturnType<typeof computeVerificationSummary>>;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalStringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = stringValue(value);
  return text === '' ? undefined : text;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function normalizeTags(value: unknown): Tag[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => objectValue(entry))
    .filter((entry) => stringValue(entry.key))
    .map((entry) => ({
      key: stringValue(entry.key),
      value: entry.value === null || entry.value === undefined ? undefined : stringValue(entry.value),
    }));
}

function normalizeItems(value: unknown): Item[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => objectValue(entry))
    .map((entry) => ({
      name: stringValue(entry.name),
      price: numberValue(entry.price),
      description: optionalStringValue(entry.description),
      image: optionalStringValue(entry.image),
      tags: normalizeTags(entry.tags),
    }));
}

function defaultTags(tool: ToolSlug): Tag[] {
  switch (tool) {
    case 'store':
      return [{ key: 'k', value: '1' }];
    case 'event':
      return [{ key: 'T', value: 'g' }];
    case 'forum':
      return [
        { key: 'i', value: '1' },
        { key: 'H', value: '0' },
        { key: 'V', value: undefined },
      ];
    case 'art':
      return [{ key: 'T', value: 'g' }];
    default:
      return [];
  }
}

function mergeDefaultTags(tool: ToolSlug, tags: Tag[]): Tag[] {
  const merged = [...tags];
  for (const defaultTag of defaultTags(tool)) {
    if (!merged.some((tag) => tag.key === defaultTag.key)) {
      merged.push(defaultTag);
    }
  }
  return merged;
}

function siteTypeForTool(tool: ToolSlug): SiteData['siteType'] {
  return tool === 'forum' ? 'discussion' : tool;
}

function hasMessageTitleTag(tags: Tag[]): boolean {
  return tags.some((tag) => tag.key === 't' && Boolean(tag.value?.trim()));
}

function prepareSiteData(tool: ToolSlug, raw: unknown): EncodableSite {
  const value = objectValue(raw);
  const tags = mergeDefaultTags(tool, normalizeTags(value.tags));

  switch (tool) {
    case 'store':
      return {
        version: 1,
        pubkey: normalizeNowherePubkey(value.pubkey),
        name: stringValue(value.name),
        description: optionalStringValue(value.description),
        image: optionalStringValue(value.image),
        tags,
        items: normalizeItems(value.items),
      };
    case 'event':
      return {
        version: 1,
        siteType: 'event',
        pubkey: optionalStringValue(normalizeNowherePubkey(value.pubkey)),
        name: stringValue(value.name),
        description: optionalStringValue(value.description),
        image: optionalStringValue(value.image),
        tags,
      };
    case 'fundraiser':
      return {
        version: 1,
        siteType: 'fundraiser',
        pubkey: optionalStringValue(normalizeNowherePubkey(value.pubkey)),
        name: stringValue(value.name),
        description: optionalStringValue(value.description),
        image: optionalStringValue(value.image),
        tags,
      };
    case 'petition':
      return {
        version: 1,
        siteType: 'petition',
        pubkey: normalizeNowherePubkey(value.pubkey),
        name: stringValue(value.name),
        description: optionalStringValue(value.description),
        image: optionalStringValue(value.image),
        tags,
      };
    case 'message':
      if (!optionalStringValue(value.description) && !hasMessageTitleTag(tags)) {
        throw new Error('Message requires either a description body or a non-empty "t" title tag.');
      }
      return {
        version: 1,
        siteType: 'message',
        pubkey: optionalStringValue(normalizeNowherePubkey(value.pubkey)),
        name: stringValue(value.name),
        description: optionalStringValue(value.description),
        image: optionalStringValue(value.image),
        tags,
      };
    case 'drop':
      return {
        version: 1,
        siteType: 'drop',
        pubkey: optionalStringValue(normalizeNowherePubkey(value.pubkey)),
        name: stringValue(value.name),
        description: stringValue(value.description),
        tags,
      };
    case 'art':
      return {
        version: 1,
        siteType: 'art',
        pubkey: optionalStringValue(normalizeNowherePubkey(value.pubkey)),
        name: stringValue(value.name),
        svg: optionalStringValue(value.svg),
        tags,
      };
    case 'forum':
      return {
        version: 1,
        siteType: 'discussion',
        pubkey: normalizeNowherePubkey(value.pubkey),
        name: stringValue(value.name),
        description: optionalStringValue(value.description),
        image: optionalStringValue(value.image),
        tags,
      };
  }
}

function encodeSite(tool: ToolSlug, siteData: EncodableSite): string {
  switch (tool) {
    case 'store':
      return encode(siteData as StoreData).fragment;
    case 'event':
      return encodeEvent(siteData as EventData).fragment;
    case 'fundraiser':
      return encodeFundraiser(siteData as FundraiserData).fragment;
    case 'petition':
      return encodePetition(siteData as PetitionData).fragment;
    case 'message':
      return encodeMessage(siteData as MessageData).fragment;
    case 'drop':
      return encodeDrop(siteData as DropData).fragment;
    case 'art':
      return encodeArt(siteData as ArtData).fragment;
    case 'forum':
      return encodeForum(siteData as ForumData).fragment;
  }
}

export async function buildSite(tool: ToolSlug, raw: unknown): Promise<BuiltSiteResult> {
  const siteData = prepareSiteData(tool, raw);
  const fragment = encodeSite(tool, siteData);
  const verification = await computeVerificationSummary({
    ...siteData,
    siteType: siteTypeForTool(tool),
  } as SiteData);

  return {
    tool,
    siteData,
    fragment,
    url: fragmentToUrl(fragment),
    verification,
  };
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null) {
    return undefined as T;
  }

  if (Array.isArray(patch)) {
    return patch as T;
  }

  if (!patch || typeof patch !== 'object') {
    return patch as T;
  }

  const baseObject = (!base || typeof base !== 'object' || Array.isArray(base))
    ? {}
    : (base as Record<string, unknown>);
  const patchObject = patch as Record<string, unknown>;
  const result: Record<string, unknown> = { ...baseObject };

  for (const [key, value] of Object.entries(patchObject)) {
    result[key] = deepMerge(result[key], value);
  }

  return result as T;
}
