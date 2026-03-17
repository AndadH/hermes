// src/tools/history.ts — already has searchChatHistory; this adds getHistory
// for structured lazy context pulling during autonomous turns.
//
// getHistory is intentionally different from searchChatHistory:
//   searchChatHistory — FTS semantic search, returns best matches for a query
//   getHistory        — structured fetch by source type, returns recent/specific content
//
// The model uses getHistory inside executeCode when it needs grounding context
// that wasn't declared in the ContextSpec at scheduling time.

import type { Env, AgentContext } from '../types';

// ── Existing searchChatHistory (unchanged) ────────────────────────────────────

export const historyDeclarations = [
  {
    name: 'searchChatHistory',
    description:
      'Full-text search across all past Telegram conversations. ' +
      'Returns the most relevant messages for a given query. ' +
      'Use when the user references something from days or weeks ago.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Keywords to search for. 1-3 words work best.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'getHistory',
    description:
      'Fetch recent structured history by source type. ' +
      'Use inside autonomous turns to pull context you need without pre-loading everything. ' +
      'More targeted than searchChatHistory — retrieves recent entries rather than best FTS matches.',
    parameters: {
      type: 'OBJECT',
      properties: {
        source: {
          type: 'STRING',
          description: '"telegram" — recent Telegram messages. More sources coming.',
        },
        limit: {
          type: 'NUMBER',
          description: 'Max number of entries to return. Default 10.',
        },
      },
      required: ['source'],
    },
  },
];

// ── Executors ─────────────────────────────────────────────────────────────────

export async function executeSearchChatHistory(
  env:   Env,
  _ctx:  AgentContext,
  query: string,
): Promise<unknown> {
  if (!query.trim()) return { results: [] };

  const { results } = await env.DB
    .prepare(`
      SELECT t.role, t.content, t.timestamp
      FROM telegram_history t
      JOIN telegram_history_fts fts ON fts.rowid = t.id
      WHERE telegram_history_fts MATCH ?
      ORDER BY rank
      LIMIT 10
    `)
    .bind(query)
    .all<{ role: string; content: string; timestamp: number }>();

  return { results: results ?? [] };
}

export async function executeGetHistory(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const source = String(args.source ?? '');
  const limit  = Math.min(Number(args.limit ?? 10), 50);

  if (source === 'telegram') {
    const { results } = await env.DB
      .prepare(`
        SELECT role, content, timestamp
        FROM telegram_history
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .bind(limit)
      .all<{ role: string; content: string; timestamp: number }>();

    return {
      source:   'telegram',
      count:    results?.length ?? 0,
      messages: (results ?? []).reverse(),
    };
  }

  return { error: 'Unknown source "' + source + '". Available: "telegram"' };
}