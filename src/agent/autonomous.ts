// src/agent/autonomous.ts
//
// Platform-agnostic autonomous agent execution.
// Called by TimerDO and CallbackDO when an alarm or trigger fires.
//
// No pre-loaded history. No platform assumptions. No chatId.
// Context is built from the ContextSpec[] the agent declared at scheduling time.
// The agent then uses getHistory / getVaultNote / etc. mid-execution for anything else.

import type { Env, StoredMessage, RecursionBudget, ContextSpec } from '../types';
import { createKernel } from './kernel';
import { telegramConfig } from './kernels/telegram';

// ── Context resolver ──────────────────────────────────────────────────────────
// Turns ContextSpec[] into StoredMessage[] that seed the agent's starting context.
// Each resolved spec becomes a clearly-labelled user message so the agent knows
// exactly where the content came from.

async function resolveContext(env: Env, specs: ContextSpec[]): Promise<StoredMessage[]> {
  const messages: StoredMessage[] = [];
  const now = Date.now();

  for (const spec of specs) {
    try {
      if (spec.source === 'telegram') {
        const limit = spec.limit ?? 10;
        const { results } = await env.DB
          .prepare(`
            SELECT role, content, timestamp
            FROM telegram_history
            ORDER BY timestamp DESC
            LIMIT ?
          `)
          .bind(limit)
          .all<{ role: string; content: string; timestamp: number }>();

        if (results?.length) {
          const lines = results
            .reverse()
            .map(r => '[' + r.role + '] ' + r.content)
            .join('\n');
          messages.push({
            role:      'user',
            content:   '[CONTEXT: recent Telegram history (' + results.length + ' messages)]\n' + lines,
            timestamp: now,
          });
        }

      } else if (spec.source === 'vault') {
        const obj = await env.VAULT.get(spec.path);
        if (obj) {
          const content = await obj.text();
          messages.push({
            role:      'user',
            content:   '[CONTEXT: vault note "' + spec.path + '"]\n' + content,
            timestamp: now,
          });
        } else {
          messages.push({
            role:      'user',
            content:   '[CONTEXT: vault note "' + spec.path + '" — not found]',
            timestamp: now,
          });
        }

      } else if (spec.source === 'history') {
        const limit = spec.limit ?? 5;
        const { results } = await env.DB
          .prepare(`
            SELECT t.role, t.content, t.timestamp
            FROM telegram_history t
            JOIN telegram_history_fts fts ON fts.rowid = t.id
            WHERE telegram_history_fts MATCH ?
            ORDER BY rank
            LIMIT ?
          `)
          .bind(spec.query, limit)
          .all<{ role: string; content: string; timestamp: number }>();

        if (results?.length) {
          const lines = results
            .map(r => '[' + r.role + '] ' + r.content)
            .join('\n');
          messages.push({
            role:      'user',
            content:   '[CONTEXT: history search "' + spec.query + '" (' + results.length + ' results)]\n' + lines,
            timestamp: now,
          });
        }

      } else if (spec.source === 'calendar') {
        // Delegate to the calendar tool directly
        const { executeGetCalendarEvents } = await import('../tools/calendar');
        const ctx = { messages: [], platform: 'telegram' as const, metadata: {} };
        const result: any = await executeGetCalendarEvents(env, ctx, {
          timeMin: spec.timeMin,
          timeMax: spec.timeMax,
        });
        if (result?.events?.length) {
          const lines = result.events
            .map((e: any) => e.start + ' — ' + e.summary)
            .join('\n');
          messages.push({
            role:      'user',
            content:   '[CONTEXT: calendar events]\n' + lines,
            timestamp: now,
          });
        }
      }
    } catch (err) {
      console.error('[autonomous] context resolution failed for spec', spec, err);
      // Non-fatal — agent runs with whatever context resolved successfully
    }
  }

  return messages;
}

// ── runAutonomousTurn ─────────────────────────────────────────────────────────

export async function runAutonomousTurn(
  env:     Env,
  intent:  string,
  budget:  RecursionBudget,
  label:   string,
  context: ContextSpec[] = [],
): Promise<void> {
  const now = Date.now();

  // Resolve declared context specs into starting messages
  const contextMessages = await resolveContext(env, context);

  // Trigger message — tells the agent what to do and what budget remains
  const triggerMessage =
    '[AUTONOMOUS TRIGGER: ' + label + ']\n' +
    'Instruction: ' + intent + '\n' +
    'Budget: depth ' + budget.depth + '/' + budget.maxDepth + '\n\n' +
    'You have full tool access. Use getHistory, readNote, or any other tool to pull ' +
    'additional context you need. Resolve the instruction above.\n' +
    '- Include your reply in the final response to notify the user via Telegram, ' +
    'or respond with nothing for silent background work.\n' +
    '- Budget is forwarded automatically if you reschedule.';

  const history: StoredMessage[] = [
    ...contextMessages,
    { role: 'user', content: triggerMessage, timestamp: now },
  ];

  const ctx = {
    messages: history,
    platform: 'telegram' as const,
    metadata: {
      budget,
      // No chatId — sendTelegramMessage reads env.TELEGRAM_CHAT_ID directly
    },
  };

  // Collect streamed tokens from the mock WebSocket
  let finalAnswer = '';
  const mockWs = {
    send(data: string) {
      try {
        const p = JSON.parse(data) as { type: string; content?: string };
        if (p.type === 'token' && p.content) finalAnswer += p.content;
      } catch { /* ignore */ }
    },
  } as unknown as WebSocket;

  try {
    const kernel = createKernel(telegramConfig, env, ctx);
    finalAnswer = await kernel.runLoop(mockWs, () => false);

    const trimmed = finalAnswer.trim();
    if (trimmed) {
      // Send to the fixed Telegram chat
      await fetch(
        'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            chat_id:    env.TELEGRAM_CHAT_ID,
            text:       trimmed,
            parse_mode: 'Markdown',
          }),
        },
      );

      // Persist both turns to D1 for continuity
      await env.DB.batch([
        env.DB
          .prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)')
          .bind(env.TELEGRAM_CHAT_ID, 'user', triggerMessage, now - 1),
        env.DB
          .prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)')
          .bind(env.TELEGRAM_CHAT_ID, 'assistant', trimmed, now),
      ]);
    }
  } catch (err) {
    console.error('[autonomous:' + label + '] turn failed:', err);
    await fetch(
      'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage',
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id:    env.TELEGRAM_CHAT_ID,
          text:       '⚠️ *Autonomous task failed* (' + label + ')\n' +
                      (err instanceof Error ? err.message : String(err)),
          parse_mode: 'Markdown',
        }),
      },
    ).catch(() => {});
  }
}