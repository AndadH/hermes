// src/tools/web.ts
import type { Env, AgentContext } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WebSearchResult {
  title:   string;
  url:     string;
  snippet: string;
}

// ── Gemini declarations ───────────────────────────────────────────────────────

export const webDeclarations = [
  {
    name: 'webSearch',
    description:
      'Search the web for current information, news, facts, or anything not in the vault. ' +
      'Returns a list of results with titles, URLs, and snippets. ' +
      'Follow up with fetchPage on the most relevant URL to get full content.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: { type: 'STRING', description: 'One sentence explaining why a web search is needed.' },
        query:     { type: 'STRING', description: 'The search query.' },
      },
      required: ['reasoning', 'query'],
    },
  },
  {
    name: 'fetchPage',
    description:
      'Fetch and read the text content of a web page by URL. ' +
      'Use after webSearch to read a full article or page. ' +
      'Only fetches URLs — does not execute JavaScript. ' +
      'Returns cleaned plain text truncated to ~4000 characters.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: { type: 'STRING', description: 'One sentence explaining why this page is worth reading.' },
        url:       { type: 'STRING', description: 'The full URL of the page to fetch.' },
      },
      required: ['reasoning', 'url'],
    },
  },
];

// ── Execute: webSearch (Tavily) ───────────────────────────────────────────────

export async function executeWebSearch(
  env:   Env,
  query: string,
): Promise<WebSearchResult[]> {
  if (!env.TAVILY_API_KEY) {
    console.error('[webSearch] TAVILY_API_KEY is not set');
    return [];
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:        env.TAVILY_API_KEY,
        query,
        search_depth:  'basic',
        max_results:    8,
        include_answer: false,  // we want raw results, not a Tavily-generated summary
      }),
    });

    if (!res.ok) {
      console.error('[webSearch] Tavily returned ' + res.status + ': ' + await res.text());
      return [];
    }

    const data: any = await res.json();
    const results: WebSearchResult[] = (data.results ?? []).map((r: any) => ({
      title:   String(r.title   ?? ''),
      url:     String(r.url     ?? ''),
      snippet: String(r.content ?? r.snippet ?? ''),
    }));

    return results;
  } catch (err) {
    console.error('[webSearch] Error:', err);
    return [];
  }
}

// ── Execute: fetchPage ────────────────────────────────────────────────────────
// Security hardening:
//   1. URL validation — must be http/https, no private/loopback IPs
//   2. Response size cap — read max 500kb before truncating
//   3. Prompt injection sanitization — strip patterns that look like injected instructions
//      before the content reaches the model's context

const BLOCKED_HOSTNAMES = new Set([
  'localhost', '0.0.0.0',
]);

export function isPrivateHost(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  // IPv4 private ranges
  if (/^127\./.test(hostname))          return true;
  if (/^10\./.test(hostname))           return true;
  if (/^192\.168\./.test(hostname))     return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  // IPv6 loopback
  if (hostname === '::1')               return true;
  return false;
}

// Sanitize fetched page content to reduce prompt injection risk.
// Strips patterns commonly used to hijack LLM context.
// This is not a complete defence — it raises the cost of injection.
export function sanitizePageContent(text: string): string {
  return text
    // Remove XML-style instruction tags
    .replace(/<\s*(system|instructions?|prompt|context|assistant|user)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '[removed]')
    // Remove lines that look like role prefixes
    .replace(/^(SYSTEM|ASSISTANT|USER|HUMAN|AI|INSTRUCTIONS?)\s*:/gmi, '[role prefix removed]:')
    // Remove common injection phrases (case-insensitive)
    .replace(/ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|context|prompts?)/gi, '[removed]')
    .replace(/your\s+(new\s+)?(instructions?|prompt|task|goal|purpose)\s+(is|are|now)/gi, '[removed]')
    .replace(/disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|context)/gi, '[removed]')
    .replace(/do\s+not\s+(follow|obey|use)\s+(previous|prior|above|your)\s+(instructions?|context|rules)/gi, '[removed]')
    .replace(/forget\s+(everything|all|prior|previous)/gi, '[removed]')
    .replace(/act\s+as\s+(if\s+)?(you\s+are|a|an)\s+/gi, '[removed] ')
    // Normalise whitespace damaged by replacements
    .replace(/\[removed\](\s*\[removed\])+/g, '[removed]')
    .trim();
}

export async function executeFetchPage(
  _ctx: AgentContext,
  url:  string,
): Promise<{ content?: string; error?: string }> {
  // ── URL validation ──────────────────────────────────────────────────────────
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'Invalid URL: ' + url };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http/https URLs are supported' };
  }

  if (isPrivateHost(parsed.hostname)) {
    return { error: 'Fetching private/loopback addresses is not allowed' };
  }

  // ── Fetch ───────────────────────────────────────────────────────────────────
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; HermesAgent/1.0)',
        'Accept':          'text/html,application/xhtml+xml,text/plain;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // Cloudflare Workers caps response body reads anyway, but be explicit
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return { error: 'HTTP ' + res.status };

    // ── Size cap — read at most 500kb ──────────────────────────────────────
    const reader     = res.body?.getReader();
    const maxBytes   = 500_000;
    let   received   = 0;
    const chunks: Uint8Array[] = [];

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        received += value.length;
        chunks.push(value);
        if (received >= maxBytes) { reader.cancel(); break; }
      }
    }

    const html = new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const merged = new Uint8Array(acc.length + c.length);
        merged.set(acc); merged.set(c, acc.length);
        return merged;
      }, new Uint8Array(0))
    );

    // ── HTML → readable text ────────────────────────────────────────────────
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 4000);

    // ── Prompt injection sanitization ───────────────────────────────────────
    const safe = sanitizePageContent(text);

    if (!safe) return { error: 'Page returned empty content' };

    return { content: safe };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[fetchPage] Error fetching "' + url + '":', msg);
    return { error: msg };
  }
}