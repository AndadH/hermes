import type { AgentContext } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ── Gemini function declarations ──────────────────────────────────────────────

export const webDeclarations = [
  {
    name: 'webSearch',
    description:
      'Search the web via DuckDuckGo for current information, news, facts, or anything not in the vault. Returns a list of results with titles, URLs, and snippets. Follow up with fetchPage on the most relevant URL to get the full content.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: { type: 'STRING', description: 'One sentence explaining why a web search is needed.' },
        query: { type: 'STRING', description: 'The search query to send to DuckDuckGo.' },
      },
      required: ['reasoning', 'query'],
    },
  },
  {
    name: 'fetchPage',
    description:
      'Fetch and read the full text content of a web page by URL. Use this after webSearch to read the full content of a promising result. Returns cleaned plain text, truncated to ~4000 characters.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: { type: 'STRING', description: 'One sentence explaining why this page is worth reading.' },
        url: { type: 'STRING', description: 'The full URL of the page to fetch.' },
      },
      required: ['reasoning', 'url'],
    },
  },
];

// ── Execute: webSearch ────────────────────────────────────────────────────────

export async function executeWebSearch(
  _ctx: AgentContext,
  query: string,
): Promise<WebSearchResult[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      console.error(`[webSearch] DDG returned ${res.status}`);
      return [];
    }

    const html = await res.text();
    const results: WebSearchResult[] = [];

    const blockRe = /<div class="result[^"]*"[\s\S]*?(?=<div class="result[^"]*"|$)/g;
    const blocks = html.match(blockRe) ?? [];

    for (const block of blocks) {
      if (results.length >= 8) break;

      const titleMatch = block.match(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const urlMatch = block.match(/href="([^"]+)"/);
      const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

      if (!titleMatch || !urlMatch) continue;

      const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
      const rawUrl = urlMatch[1];
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, '').trim()
        : '';

      // DDG HTML wraps URLs — decode the actual target
      let finalUrl = rawUrl;
      try {
        const parsed = new URL(rawUrl, 'https://duckduckgo.com');
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) finalUrl = decodeURIComponent(uddg);
      } catch { /* keep rawUrl */ }

      if (title && finalUrl) {
        results.push({ title, url: finalUrl, snippet });
      }
    }

    return results;
  } catch (err) {
    console.error('[webSearch] Error:', err);
    return [];
  }
}

// ── Execute: fetchPage ────────────────────────────────────────────────────────

export async function executeFetchPage(
  _ctx: AgentContext,
  url: string,
): Promise<{ content?: string; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!res.ok) return { error: `HTTP ${res.status}` };

    const html = await res.text();

    // Strip scripts, styles, and tags — leave readable text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 4000);

    return { content: text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fetchPage] Error fetching "${url}":`, msg);
    return { error: msg };
  }
}