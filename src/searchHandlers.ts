import type { Context } from 'hono';
import type { Env, SearchResult } from './types';

/**
 * POST /search
 * Body: { query: string }
 *
 * Standalone semantic search against the hermes-vault AutoRAG index.
 * Returns up to 50 results with scores and Obsidian wikilinks.
 * Used by the Obsidian Semantic Search panel directly (without the chat agent).
 */
export async function handleSearch(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const body = await c.req.json<{ query?: string }>();
  const query = body.query?.trim();

  if (!query) {
    return c.json({ error: '"query" is required' }, 400);
  }

  try {
    const response = await (c.env.AI as any).autorag('hermes-vault').search({
      query,
      max_num_results: 50,
      rewrite_query: true,
    });

    const results: SearchResult[] = (response?.data ?? []).map((r: any) => {
      const rawFilename: string = r.filename ?? r.id ?? 'Unknown';
      const noteName = rawFilename.replace(/\.md$/i, '');

      const excerpt: string = (r.content ?? [])
        .map((c: any) => (c.text as string) ?? '')
        .join('\n')
        .slice(0, 400);

      return {
        filename: rawFilename,
        score: Math.round((r.score ?? 0) * 100) / 100,
        link: `[[${noteName}]]`,
        excerpt,
      };
    });

    return c.json({ results, count: results.length });
  } catch (err) {
    console.error('[search] AutoRAG error:', err);
    return c.json({ error: 'Search failed' }, 500);
  }
}