import { describe, it, expect } from 'vitest';
import { safeJson } from '../src/tools/entities';

describe('Data Integrity: safeJson (Entity Store)', () => {
  it('passes through valid JSON strings', () => {
    const validStr = '{"role": "Engineer", "level": 5}';
    expect(safeJson(validStr)).toBe(validStr);
  });

  it('stringifies valid JavaScript objects', () => {
    const obj = { project: "Hermes", active: true };
    expect(safeJson(obj)).toBe('{"project":"Hermes","active":true}');
  });

  it('returns the fallback for malformed JSON strings', () => {
    const badStr = '{ role: "Engineer"'; // Missing quotes and closing brace
    expect(safeJson(badStr)).toBe('{}');
    expect(safeJson(badStr, '{"error": true}')).toBe('{"error": true}');
  });

  it('returns the fallback for null or undefined', () => {
    expect(safeJson(null)).toBe('{}');
    expect(safeJson(undefined)).toBe('{}');
  });
});