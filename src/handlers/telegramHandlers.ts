// src/handlers/telegramHandlers.ts
import type { Context } from 'hono';
import type { Env, StoredMessage, CallbackEntry } from '../types';
import { runTelegramTurn } from '../agent/index';
import { runAutonomousTurn } from '../agent/autonomous';

const MAX_HISTORY       = 10;
const CONTEXT_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ── Main webhook entrypoint ───────────────────────────────────────────────────

export async function handleTelegramWebhook(c: Context<{ Bindings: Env }>) {
  const body          = await c.req.json();
  const allowedUserId = Number(c.env.TELEGRAM_ALLOWED_USER_ID);

  // ── message_reaction ──────────────────────────────────────────────────────
  if (body.message_reaction) {
    const reaction = body.message_reaction;
    if (reaction.user?.id !== allowedUserId) return c.json({ status: 'ignored' });

    const messageId  = reaction.message_id as number;
    const newEmojis: string[] = (reaction.new_reaction ?? [])
      .filter((r: any) => r.type === 'emoji')
      .map((r: any) => r.emoji as string);

    c.executionCtx.waitUntil(handleReactionCallbacks(c.env, messageId, newEmojis));
    return c.json({ status: 'ok' });
  }

  // ── message ───────────────────────────────────────────────────────────────
  const message = body.message;
  if (!message?.text || !message?.from) return c.json({ status: 'ignored' });
  if (message.from.id !== allowedUserId) {
    console.warn('Unauthorized Telegram access from ID: ' + message.from.id);
    return c.json({ status: 'unauthorized' });
  }

  const chatId = message.chat.id as number;
  const text   = message.text as string;

  if (text.trim() === '/clear') {
    c.executionCtx.waitUntil(clearTelegramContext(c.env, chatId));
    return c.json({ status: 'ok' });
  }

  if (text.trim() === '/delete') {
    c.executionCtx.waitUntil(deleteTelegramHistory(c.env, chatId));
    return c.json({ status: 'ok' });
  }

  c.executionCtx.waitUntil(processTelegramMessage(c.env, chatId, text));
  return c.json({ status: 'ok' });
}

// ── /clear ────────────────────────────────────────────────────────────────────

async function clearTelegramContext(env: Env, chatId: number) {
  try {
    await env.DB.prepare(
      'INSERT INTO telegram_context_start (chatId, startedAt) VALUES (?, ?) ' +
      'ON CONFLICT(chatId) DO UPDATE SET startedAt = excluded.startedAt'
    ).bind(chatId, Date.now()).run();
    await tgSend(env, chatId, "🧹 Context cleared. Starting fresh — past conversations still searchable.");
  } catch (err) {
    console.error('[telegram] clearTelegramContext error:', err);
  }
}

// ── /delete ───────────────────────────────────────────────────────────────────
// Hard deletes ALL telegram_history rows for this chat from D1.
// Also removes the context_start entry so /clear state is reset.
// Irreversible — use /clear instead if you just want a fresh context window
// while keeping history searchable.

async function deleteTelegramHistory(env: Env, chatId: number) {
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM telegram_history WHERE chatId = ?').bind(chatId),
      env.DB.prepare('DELETE FROM telegram_context_start WHERE chatId = ?').bind(chatId),
    ]);

    await tgSend(env, chatId,
      '🗑️ *Message history deleted.* All conversation history for this chat has been permanently removed from the database.\n\n' +
      'Use /clear to reset the context window while keeping history searchable.'
    );
  } catch (err) {
    console.error('[telegram] deleteTelegramHistory error:', err);
    await tgSend(env, chatId, '⚠️ Failed to delete history. Please try again.');
  }
}

// ── Message processing ────────────────────────────────────────────────────────

async function processTelegramMessage(env: Env, chatId: number, text: string) {
  const now        = Date.now();
  const cutoffTime = now - CONTEXT_EXPIRY_MS;

  const contextRow = await env.DB
    .prepare('SELECT startedAt FROM telegram_context_start WHERE chatId = ?')
    .bind(chatId)
    .first<{ startedAt: number }>();

  const historyFrom = Math.max(cutoffTime, contextRow?.startedAt ?? 0);

  const { results } = await env.DB.prepare(
    'SELECT role, content, timestamp FROM telegram_history ' +
    'WHERE chatId = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT ?'
  ).bind(chatId, historyFrom, MAX_HISTORY)
   .all<{ role: string; content: string; timestamp: number }>();

  const history: StoredMessage[] = (results ?? []).reverse().map(row => ({
    role:      row.role as 'user' | 'assistant',
    content:   row.content,
    timestamp: row.timestamp,
  }));
  history.push({ role: 'user', content: text, timestamp: now });

  // Fire message callbacks truly fire-and-forget — never block the main turn
  fireMessageCallbacks(env, text).catch(err =>
    console.error('[telegram] fireMessageCallbacks error:', err)
  );

  // Single placeholder — replaced exactly once when the agent is done
  const placeholderRes  = await tgSend(env, chatId, '…');
  const placeholderData: any = await placeholderRes.json();
  const messageId        = placeholderData.result?.message_id as number | undefined;

  try {
    // Collect tool labels as the agent runs — no timers, no loops
    const toolsUsed: string[] = [];

    const mockWs = {
      send(dataStr: string) {
        try {
          const p = JSON.parse(dataStr) as { type: string; label?: string };
          if (p.type === 'toolCall' && p.label) toolsUsed.push(p.label);
        } catch { /* ignore parse errors */ }
      },
    } as unknown as WebSocket;

    const finalContent = await runTelegramTurn(env, mockWs, history, chatId, () => false);

    // One edit: optional tool summary line + final answer
    const toolLine    = toolsUsed.length > 0 ? '_🔧 ' + toolsUsed.join(' · ') + '_\n\n' : '';
    const fullMessage = (toolLine + (finalContent ?? '')).trim();

    if (messageId) {
      await tgEdit(env, chatId, messageId, fullMessage || '✓');
    }

    // Persist both turns
    if (finalContent) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)')
          .bind(chatId, 'user', text, now),
        env.DB.prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)')
          .bind(chatId, 'assistant', finalContent, Date.now()),
      ]);
    }

  } catch (err) {
    console.error('[telegram] processTelegramMessage error:', err);
    const errMsg = '⚠️ Something went wrong. Please try again.';
    if (messageId) await tgEdit(env, chatId, messageId, errMsg);
    else await tgSend(env, chatId, errMsg);
  }
}

// ── Telegram API helpers ──────────────────────────────────────────────────────

function tgSend(env: Env, chatId: number, text: string): Promise<Response> {
  return fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

function tgEdit(env: Env, chatId: number, messageId: number, text: string): Promise<Response> {
  return fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/editMessageText', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' }),
  });
}

// ── Callback firing ───────────────────────────────────────────────────────────

async function fireMessageCallbacks(env: Env, text: string): Promise<void> {
  const stub = env.CALLBACK_DO.get(env.CALLBACK_DO.idFromName('callbacks'));
  let matches: CallbackEntry[] = [];

  try {
    const res = await stub.fetch(new Request('https://callback-do/check-message', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    }));
    if (!res.ok) return;
    matches = ((await res.json()) as any).matches ?? [];
  } catch (err) {
    console.error('[telegram] callback check-message failed:', err);
    return;
  }

  for (const entry of matches) {
    await runAutonomousTurn(
      env,
      entry.intent,
      { depth: entry.depth + 1, maxDepth: entry.maxDepth, originTs: entry.originTs },
      'callback:' + entry.id,
      entry.context ?? [],
    ).catch(err => console.error('[telegram] callback ' + entry.id + ' failed:', err));
  }
}

async function handleReactionCallbacks(env: Env, messageId: number, emojis: string[]): Promise<void> {
  if (!emojis.length) return;

  const stub      = env.CALLBACK_DO.get(env.CALLBACK_DO.idFromName('callbacks'));
  const seenIds   = new Set<string>();
  const allMatches: CallbackEntry[] = [];

  for (const emoji of emojis) {
    try {
      const res = await stub.fetch(new Request('https://callback-do/check-reaction', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ emoji, messageId }),
      }));
      if (!res.ok) continue;
      const data: any = await res.json();
      for (const entry of (data.matches ?? []) as CallbackEntry[]) {
        if (!seenIds.has(entry.id)) { seenIds.add(entry.id); allMatches.push(entry); }
      }
    } catch (err) {
      console.error('[telegram] reaction check failed for emoji ' + emoji + ':', err);
    }
  }

  for (const entry of allMatches) {
    await runAutonomousTurn(
      env,
      entry.intent,
      { depth: entry.depth + 1, maxDepth: entry.maxDepth, originTs: entry.originTs },
      'callback:' + entry.id,
      entry.context ?? [],
    ).catch(err => console.error('[telegram] reaction callback ' + entry.id + ' failed:', err));
  }
}