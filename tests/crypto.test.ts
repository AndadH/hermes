import { describe, it, expect } from 'vitest';
import { sha256Hex } from '../src/tools/vault';

describe('Cryptography: sha256Hex', () => {
  it('1. produces a correct 64-character hex string', async () => {
    const hash = await sha256Hex('Hello Hermes');
    expect(hash).toHaveLength(64);
    expect(/^[a-f0-9]+$/.test(hash)).toBe(true); // Ensures it's valid hex
  });

  it('2. is perfectly deterministic for identical inputs', async () => {
    const input = 'The quick brown fox jumps over the lazy dog.';
    const hash1 = await sha256Hex(input);
    const hash2 = await sha256Hex(input);
    expect(hash1).toBe(hash2);
  });

  it('3. produces entirely different hashes for minor input changes', async () => {
    const hash1 = await sha256Hex('Project Alpha');
    const hash2 = await sha256Hex('Project alpha'); // Lowercase 'a'
    expect(hash1).not.toBe(hash2);
  });
});