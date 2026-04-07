import { describe, it, expect } from 'vitest';
import { parseArxivXml } from '../src/tools/research'; // Make sure to export this

describe('Research Tool: parseArxivXml', () => {
  const mockXml = `
    <feed>
      <entry>
        <id>http://arxiv.org/abs/2301.07041</id>
        <published>2023-01-15T00:00:00Z</published>
        <title>Mixture of Experts for LLMs</title>
        <summary>  This is a detailed abstract about routing tokens.  </summary>
        <author><name>Alice Smith</name></author>
        <author><name>Bob Jones</name></author>
      </entry>
    </feed>
  `;

  it('parses full responses correctly (brief=false)', () => {
    const results = parseArxivXml(mockXml, false, 800) as any[];
    
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('2301.07041');
    expect(results[0].title).toBe('Mixture of Experts for LLMs');
    expect(results[0].authors).toEqual(['Alice Smith', 'Bob Jones']);
    expect(results[0].abstract).toBe('This is a detailed abstract about routing tokens.');
    expect(results[0].pdf).toBe('https://arxiv.org/pdf/2301.07041');
  });

  it('strips abstract and PDF links when brief=true', () => {
    const results = parseArxivXml(mockXml, true, 800) as any[];
    
    expect(results).toHaveLength(1);
    expect(results[0].abstract).toBeUndefined();
    expect(results[0].pdf).toBeUndefined();
    expect(results[0].id).toBe('2301.07041'); // Ensure base data is still there
  });

  it('truncates abstract to specified length', () => {
    const results = parseArxivXml(mockXml, false, 10) as any[];
    expect(results[0].abstract.length).toBeLessThanOrEqual(10);
    expect(results[0].abstract).toBe('This is a ');
  });
});