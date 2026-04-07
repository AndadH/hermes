import { describe, it, expect } from 'vitest';
import { normalizePath } from '../src/tools/vault';

describe('File System: Vault Path Normalization', () => {
  it('appends .md if it is missing', () => {
    expect(normalizePath('Ideas/Project Hermes')).toBe('Ideas/Project Hermes.md');
    expect(normalizePath('meeting-notes')).toBe('meeting-notes.md');
  });

  it('does not append .md if it is already present', () => {
    expect(normalizePath('journal/2026-04-06.md')).toBe('journal/2026-04-06.md');
  });

  it('trims whitespace before normalizing', () => {
    expect(normalizePath('  messy file name  ')).toBe('messy file name.md');
    expect(normalizePath('  already has extension.md  ')).toBe('already has extension.md');
  });
});