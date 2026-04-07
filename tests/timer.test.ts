import { describe, it, expect } from 'vitest';
import { resolveBudget } from '../src/tools/timer'; // Make sure to export this
import type { AgentContext } from '../src/types';

describe('Timer Tool: resolveBudget', () => {
  const baseCtx: AgentContext = {
    messages: [],
    platform: 'telegram',
    metadata: {},
  };

  it('initializes a fresh budget if none exists in context', () => {
    const args = { maxDepth: 3 };
    const result = resolveBudget(args, baseCtx);
    
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.depth).toBe(0);
      expect(result.maxDepth).toBe(3);
      expect(result.originTs).toBeLessThanOrEqual(Date.now());
    }
  });

  it('increments depth and respects context limits', () => {
    const activeCtx: AgentContext = {
      ...baseCtx,
      metadata: {
        budget: { depth: 2, maxDepth: 5, originTs: 100000 },
      },
    };
    
    const args = {}; // Agent didn't pass maxDepth, should inherit
    const result = resolveBudget(args, activeCtx);
    
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      expect(result.depth).toBe(2);
      expect(result.maxDepth).toBe(5);
    }
  });

  it('hard fails when recursion depth meets or exceeds maxDepth', () => {
    const exhaustedCtx: AgentContext = {
      ...baseCtx,
      metadata: {
        budget: { depth: 5, maxDepth: 5, originTs: 100000 },
      },
    };
    
    const result = resolveBudget({}, exhaustedCtx);
    expect(result).toHaveProperty('error');
    expect((result as any).error).toContain('Recursion limit');
  });
});