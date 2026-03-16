import type { Context } from 'hono';
import type { Env, StoredMessage } from '../types';
import { runTelegramTurn } from '../agent/index';

const MAX_HISTORY       = 10;
const CONTEXT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const EDIT_INTERVAL_MS  = 1200;

export async function handleTelegramWebhook(c: Context<{ Bindings: Env }>) {
  const body    = await c.req.json();
  const message = body.message;

  if (!message || !message.text || !message.from) {
    return c.json({ status: 'ignored' });
  }

  const allowedUserId = Number(c.env.TELEGRAM_ALLOWED_USER_ID);
  if (message.from.id !== allowedUserId) {
    console.warn(`Unauthorized Telegram access attempt from ID: ${message.from.id}`);
    return c.json({ status: 'unauthorized' });
  }

  const chatId = message.chat.id;
  const text   = message.text as string;

  // ── /clear — resets the rolling context window without touching D1 history ─
  // All past messages remain searchable via searchChatHistory.
  // The next message will only see messages sent after this point.
  if (text.trim() === '/clear') {
    c.executionCtx.waitUntil(clearTelegramContext(c.env, chatId));
    return c.json({ status: 'ok' });
  }

  c.executionCtx.waitUntil(processTelegramMessage(c.env, chatId, text));
  return c.json({ status: 'ok' });
}

// ── /clear ────────────────────────────────────────────────────────────────────
// Upserts a contextStartedAt timestamp for this chat.
// History loading uses MAX(cutoffTime, contextStartedAt) so old messages
// stay in D1 (fully searchable) but are excluded from the live context window.

async function clearTelegramContext(env: Env, chatId: number) {
  try {
    await env.DB.prepare(`
      INSERT INTO telegram_context_start (chatId, startedAt)
      VALUES (?, ?)
      ON CONFLICT(chatId) DO UPDATE SET startedAt = excluded.startedAt
    `).bind(chatId, Date.now()).run();

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id: chatId,
        text:    '🧹 Context cleared. I\'ll start fresh — but I can still search our past conversations if you need them.',
      }),
    });
  } catch (err) {
    console.error('[telegram] clearTelegramContext error:', err);
  }
}

// ── Message processing ────────────────────────────────────────────────────────

async function processTelegramMessage(env: Env, chatId: number, text: string) {
  const now        = Date.now();
  const cutoffTime = now - CONTEXT_EXPIRY_MS;

  // Fetch the context start time for this chat (set by /clear), if any
  const contextRow = await env.DB
    .prepare('SELECT startedAt FROM telegram_context_start WHERE chatId = ?')
    .bind(chatId)
    .first<{ startedAt: number }>();

  // Use whichever lower bound is more recent: the 24h rolling window or the last /clear
  const historyFrom = Math.max(cutoffTime, contextRow?.startedAt ?? 0);

  const { results } = await env.DB.prepare(`
    SELECT role, content, timestamp
    FROM telegram_history
    WHERE chatId = ? AND timestamp > ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).bind(chatId, historyFrom, MAX_HISTORY).all<{ role: string; content: string; timestamp: number }>();

  const history: StoredMessage[] = (results ?? []).reverse().map((row) => ({
    role:      row.role as 'user' | 'assistant',
    content:   row.content,
    timestamp: row.timestamp,
  }));
  history.push({ role: 'user', content: text, timestamp: now });

  try {
    // 1. Send placeholder
    const initialRes  = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: 'Thinking...', parse_mode: 'Markdown' }),
    });
    const initialData: any = await initialRes.json();
    const messageId = initialData.result.message_id;

    // 2. Live tool-log UI
    let toolLogs      = 'Thinking...\n';
    let finalAnswer   = '';
    let isEditing     = false;
    let pendingUpdate = false;

    const mockWs = {
      send: (dataString: string) => {
        const payload = JSON.parse(dataString) as any;
        if (payload.type === 'token') {
          finalAnswer += payload.content;
        } else if (payload.type === 'toolCall') {
          toolLogs += `\n• ${payload.label}`;
          if (!isEditing) {
            isEditing = true;
            (async () => {
              while (true) {
                try {
                  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ chat_id: chatId, message_id: messageId, text: toolLogs }),
                  });
                } catch { /* ignore rate limits */ }
                await new Promise((r) => setTimeout(r, EDIT_INTERVAL_MS));
                if (!pendingUpdate) { isEditing = false; break; }
                pendingUpdate = false;
              }
            })();
          } else {
            pendingUpdate = true;
          }
        }
      },
    } as unknown as WebSocket;

    // 3. Run agent
    const finalContent = await runTelegramTurn(env, mockWs, history, chatId, () => false);

    // 4. Send final answer
    if (finalContent) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id:    chatId,
          message_id: messageId,
          text:       finalContent,
          parse_mode: 'Markdown',
        }),
      });
    }

    // 5. Persist both turns (always — history is permanent for searchChatHistory)
    await env.DB.batch([
      env.DB.prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)').bind(chatId, 'user', text, now),
      env.DB.prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)').bind(chatId, 'assistant', finalContent, Date.now()),
    ]);

  } catch (err) {
    console.error('[telegram] processTelegramMessage error:', err);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: '⚠️ Something went wrong. Please try again.' }),
    });
  }
}