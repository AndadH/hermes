import { describe, it, expect } from 'vitest';
import { formatFiresAt } from '../src/tools/timer';
import { defaultDateRange } from '../src/tools/research';

describe('Deterministic Time: Timers and Data Ranges', () => {
  describe('formatFiresAt (Timer tool)', () => {
    it('7. formats a 0-minute delay correctly', () => {
      // It should return a string like "11:36 PM, Apr 6"
      const result = formatFiresAt(0);
      expect(typeof result).toBe('string');
      expect(result).toMatch(/[A-Z][a-z]{2}\s\d{1,2},\s\d{1,2}:\d{2}\s[AP]M/);
    });

    it('8. formats future minutes successfully', () => {
      const result = formatFiresAt(1440); // 24 hours from now
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(5);
    });
  });

  describe('defaultDateRange (FRED/WorldBank tools)', () => {
    it('9. returns exactly the requested year difference', () => {
      const range = defaultDateRange(5);
      const startYear = parseInt(range.start.split('-')[0], 10);
      const endYear = parseInt(range.end.split('-')[0], 10);
      
      expect(endYear - startYear).toBe(5);
    });

    it('10. outputs strict YYYY-MM-DD formats for the APIs', () => {
      const { start, end } = defaultDateRange(1);
      
      const regex = /^\d{4}-\d{2}-\d{2}$/;
      expect(start).toMatch(regex);
      expect(end).toMatch(regex);
    });
  });
});