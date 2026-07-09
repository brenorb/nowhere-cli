import { describe, expect, test } from 'vitest';
import { getCreateToolDefinition, type ToolSlug } from '../src/lib/create-tools.js';

function hostedTagKeys(tool: ToolSlug): string[] {
  return getCreateToolDefinition(tool).promptSteps.flatMap((step) => {
    if ('tagKey' in step && typeof step.tagKey === 'string') {
      return [step.tagKey];
    }
    return [];
  });
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
});
