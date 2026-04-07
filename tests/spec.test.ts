import { describe, it, expect } from 'vitest';
import { buildToolSpec } from '../src/tools/spec';
import type { ToolDef } from '../src/tools/registry';

describe('Architecture: buildToolSpec', () => {
  // Create a mock registry with two tools to verify category grouping and arg parsing
  const mockRegistry: Record<string, ToolDef> = {
    testToolA: {
      description: 'A test tool',
      category: 'research',
      tags: ['test'],
      returns: '{ success: boolean }',
      execute: async () => ({}),
      geminiDeclaration: {
        name: 'testToolA',
        description: 'A test tool',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'search query' }
          },
          required: ['query']
        }
      }
    },
    testToolB: {
      description: 'Another tool',
      category: 'research',
      tags: ['test2'],
      returns: '{ count: number }',
      execute: async () => ({}),
      geminiDeclaration: {
        name: 'testToolB',
        description: 'Another tool',
        parameters: {
          type: 'OBJECT',
          properties: {
            limit: { type: 'NUMBER', description: 'max limits' }
          },
          required: [] // 'limit' is optional
        }
      }
    }
  };

  it('builds the __index category map correctly', () => {
    const spec = buildToolSpec(mockRegistry);
    
    expect(spec.__index).toBeDefined();
    expect(spec.__index.research).toBeDefined();
    // It should group both tools under the 'research' category
    expect(spec.__index.research.tools).toEqual(['testToolA', 'testToolB']);
  });

  it('correctly maps required vs optional arguments', () => {
    const spec = buildToolSpec(mockRegistry);
    
    // testToolA requires 'query'
    expect(spec.testToolA.args.query).toBeDefined();
    expect(spec.testToolA.args.query.required).toBe(true);
    expect(spec.testToolA.args.query.type).toBe('string');

    // testToolB has 'limit' as optional
    expect(spec.testToolB.args.limit).toBeDefined();
    expect(spec.testToolB.args.limit.required).toBe(false);
    expect(spec.testToolB.args.limit.type).toBe('number');
  });
});