import { describe, it, expect } from 'vitest';
import { toolLabel } from '../src/agent/gemini';

describe('UI Parsing: toolLabel Generation', () => {
  it('generates basic tool labels', () => {
    expect(toolLabel('searchVault', { query: 'anthropic' })).toBe('Searching vault for "anthropic"…');
    expect(toolLabel('getCalendarEvents', {})).toBe('Checking calendar…');
  });

  it('extracts subjects from discoverTools code strings', () => {
    // Tests the regex: code.match(/includes\(['"]([^'"]+)['"]\)|===\s*['"]([^'"]+)['"]/)
    const args = {
      code: "const spec = await codemode.spec(); return spec.__index.vault.tools.includes('searchVault');"
    };
    expect(toolLabel('discoverTools', args)).toBe('Discovering tools: searchVault…');

    // Tests fallback to property access regex: code.match(/spec\.(\w+)/)
    const argsProp = {
      code: "const spec = await codemode.spec(); return spec.newtonMath.args;"
    };
    expect(toolLabel('discoverTools', argsProp)).toBe('Discovering tools: newtonMath…');
  });

  it('extracts and deduplicates tools from executeCode strings', () => {
    // Tests the regex: code.matchAll(/codemode\.(\w+)\s*\(/g)
    const args = {
      code: `
        await codemode.readNote({ path: "test.md" });
        await codemode.webSearch({ query: "news" });
        await codemode.readNote({ path: "test2.md" }); // Duplicate call
      `
    };
    const label = toolLabel('executeCode', args);
    // Should deduplicate 'readNote' and list them
    expect(label).toBe('Running readNote + webSearch…');
  });

  it('truncates executeCode labels if more than 3 unique tools are called', () => {
    const args = {
      code: `
        await codemode.toolA();
        await codemode.toolB();
        await codemode.toolC();
        await codemode.toolD();
        await codemode.toolE();
      `
    };
    const label = toolLabel('executeCode', args);
    expect(label).toBe('Running toolA + toolB + toolC + 2 more…');
  });
});