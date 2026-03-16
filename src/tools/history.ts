import type { Env, AgentContext } from '../types';

// ── Gemini function declaration ───────────────────────────────────────────────

export const historyDeclarations = [
  {
    name: 'searchChatHistory',
    description:
      'Search past Telegram conversation history using full-text search. Use when the user references past conversations, previous topics, or things discussed days/weeks ago. Keep queries simple — 1-3 distinct keywords work best.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: { type: 'STRING', description: 'One sentence explaining why past chat history is relevant.' },
        query: { type: 'STRING', description: '1-3 keywords to search for in past conversations.' },
      },
      required: ['reasoning', 'query'],
    },
  },
];

// ── Execute: searchChatHistory ────────────────────────────────────────────────

export async function executeSearchChatHistory(
  env: Env,
  _ctx: AgentContext,
  query: string,
): Promise<unknown> {
  try {
    // FTS5 MATCH supports advanced syntax (AND, OR, NOT, prefix*).
    // Clean the query to prevent SQL syntax errors from weird LLM formatting.
    const cleanQuery = query.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (!cleanQuery) return { message: 'Search query was empty.' };

    const { results } = await env.DB.prepare(`
      SELECT
        t.role,
        t.content,
        datetime(t.timestamp / 1000, 'unixepoch') as date
      FROM telegram_history t
      JOIN telegram_history_fts fts ON t.id = fts.rowid
      WHERE telegram_history_fts MATCH ?
      ORDER BY rank
      LIMIT 10
    `).bind(cleanQuery).all<{ role: string; content: string; date: string }>();

    if (!results?.length) return { message: 'No past conversations found for that query.' };

    return { results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[searchChatHistory] Error:', msg);
    return { error: msg };
  }
}