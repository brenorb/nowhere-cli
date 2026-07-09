import { describe, expect, test } from 'vitest';
import { getCreateToolDefinition, type ToolSlug } from '../src/lib/create-tools.js';

function hostedTagKeys(tool: ToolSlug): string[] {
  return getCreateToolDefinition(tool).promptSteps.flatMap((step) => {
    if (
      (step.kind === 'tag-text' || step.kind === 'tag-choice' || step.kind === 'tag-boolean')
      && 'tagKey' in step
      && typeof step.tagKey === 'string'
    ) {
      return [step.tagKey];
    }
    return [];
  });
}

function structuredStepKinds(tool: ToolSlug): string[] {
  const structuredKinds = new Set([
    'contacts',
    'field-states',
    'store-payments',
    'tag-list',
    'tag-pairs',
    'tips',
  ]);
  return getCreateToolDefinition(tool).promptSteps
    .map((step) => step.kind)
    .filter((kind) => structuredKinds.has(kind));
}

describe('hosted builder create schema', () => {
  test.each([
    ['store', ['b', '$', 'w', 'r', 'Y', 'Q', 'G', 'I', 'L', 's', 'S', 'h', 'H', 'm', 'B', 'X', 'D', 'c', 'x']],
    ['event', ['T', 'C', 'o', 'D', 'd', 'L', 'l', 'O', 'b', '$', 'K', 'r', 'A', 'q', 'R', 'v', 'G', 'I']],
    ['fundraiser', ['T', '$', 'g', 'h', 't', 'b', 'Q', 'G', 'I']],
    ['petition', ['T', 'g', 'h', 't', 'b', 'R', 'c', 'G', 'I']],
    ['message', ['G', 'I']],
    ['drop', []],
    ['art', ['A', 'T']],
    ['forum', ['O', 'i', 'H', 'm', 'W', '3', '4', 'X', 'S', '9', 'L', 'b', 'q', 'F', '5', 'h']],
  ] satisfies Array<[ToolSlug, string[]]>)('maps %s scalar fields to canonical hosted tags', (tool, keys) => {
    expect(hostedTagKeys(tool)).toEqual(keys);
  });

  test.each([
    ['store', ['contacts', 'store-payments', 'field-states']],
    ['event', ['tag-pairs', 'tag-list', 'contacts']],
    ['fundraiser', ['tips', 'contacts']],
    ['petition', ['tag-pairs', 'field-states', 'contacts']],
    ['message', ['tips', 'contacts']],
    ['drop', []],
    ['art', []],
    ['forum', []],
  ] satisfies Array<[ToolSlug, string[]]>)('maps %s structured hosted fields', (tool, kinds) => {
    expect(structuredStepKinds(tool)).toEqual(kinds);
  });
});
