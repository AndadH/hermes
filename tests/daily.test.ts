import { describe, it, expect } from 'vitest';
import { parseDate, notePath } from '../src/tools/daily';

describe('Strict Validation: Daily Journal Dates', () => {
  describe('parseDate', () => {
    it('accepts strict YYYY-MM-DD formats', () => {
      expect(parseDate('2026-04-06')).toBe('2026-04-06');
      expect(parseDate(' 2026-12-31 ')).toBe('2026-12-31'); // Should trim
    });

    it('rejects conversational dates (forces LLM to correct itself)', () => {
      expect(parseDate('today')).toBeNull();
      expect(parseDate('tomorrow')).toBeNull();
      expect(parseDate('April 6th, 2026')).toBeNull();
    });

    it('rejects alternative numeric formats', () => {
      expect(parseDate('04/06/2026')).toBeNull();
      expect(parseDate('2026/04/06')).toBeNull();
      expect(parseDate('26-04-06')).toBeNull();
    });
  });

  describe('notePath', () => {
    it('constructs the correct journal directory path', () => {
      expect(notePath('2026-04-06')).toBe('journal/2026-04-06.md');
    });
  });
});