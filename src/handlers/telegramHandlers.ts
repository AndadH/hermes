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

    if (!fullMessage) {
      // finalContent was empty — log everything we know for debugging
      console.error('[telegram] empty response — tools used: [' + (toolsUsed.join(', ') || 'none') + ']');
    }

    if (messageId) {
      // Always send something — empty response sends a generic error rather than frozen …
      await tgEdit(env, chatId, messageId, fullMessage || '⚠️ Something went wrong generating a response. Please try again.');
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

async function tgSend(env: Env, chatId: number, text: string): Promise<Response> {
  const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('[tgSend] failed ' + res.status + ':', body);
  }
  return res;
}

async function tgSendPlain(env: Env, chatId: number, text: string): Promise<void> {
  await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text }),
  });
}

// Try to edit a message. Retries once after 1.5s on failure.
// If both attempts fail, falls back to sending a fresh message.
// Handles Markdown parse errors by retrying without parse_mode.
async function tgEdit(env: Env, chatId: number, messageId: number, text: string): Promise<void> {
  const attempt = async (parseMode?: string): Promise<{ ok: boolean; body: string }> => {
    const payload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
    if (parseMode) payload.parse_mode = parseMode;
    const res  = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/editMessageText', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const body = await res.text();
    return { ok: res.ok, body };
  };

  // First attempt with Markdown
  let result = await attempt('Markdown');

  if (!result.ok) {
    console.error('[tgEdit] attempt 1 failed:', result.body);

    // If Markdown parse error — retry immediately without formatting
    if (result.body.includes("can't parse entities")) {
      result = await attempt();
      if (result.ok) return;
      console.error('[tgEdit] plain retry failed:', result.body);
    } else {
      // Other failure — wait 1.5s and retry with Markdown
      await new Promise(r => setTimeout(r, 1500));
      result = await attempt('Markdown');
      if (result.ok) return;
      console.error('[tgEdit] attempt 2 failed:', result.body);

      // Final fallback: try plain text
      result = await attempt();
      if (result.ok) return;
      console.error('[tgEdit] plain fallback failed:', result.body);
    }

    // All edit attempts failed — send a fresh message so the user isn't left with …
    console.error('[tgEdit] all attempts failed, sending fresh message');
    await tgSendPlain(env, chatId, text);
  }
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