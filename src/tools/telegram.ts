// src/tools/telegram.ts
// sendTelegramMessage — proactive send from any context (live turn or autonomous).
// Reads env.TELEGRAM_CHAT_ID as the default — there is one chat, always.
// ctx.metadata.chatId can override if ever needed (e.g. multi-user expansion).

import type { Env, AgentContext } from '../types';

export const telegramDeclarations = [
  {
    name: 'sendTelegramMessage',
    description:
      'Send a proactive Telegram message at any point during a turn. ' +
      'Works from any context — live conversation, timer, callback, or Obsidian. ' +
      'Use when you want to notify mid-turn or from an autonomous task. ' +
      'In a live Telegram turn you can also just include the message in your final response.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: {
          type: 'STRING',
          description: 'Message text. Telegram Markdown supported: **bold**, *italic*, `code`, [label](url).',
        },
      },
      required: ['text'],
    },
  },
];

export async function executeSendTelegramMessage(
  args: Record<string, unknown>,
  env:  Env,
  ctx:  AgentContext,
): Promise<unknown> {
  const text   = String(args.text ?? '').trim();
  // ctx.metadata.chatId allows override; falls back to the fixed env var
  const chatId = ctx.metadata.chatId
    ? String(ctx.metadata.chatId)
    : env.TELEGRAM_CHAT_ID;

  if (!text)   return { error: 'text is required' };
  if (!chatId) return { error: 'No TELEGRAM_CHAT_ID configured — set via wrangler secret put TELEGRAM_CHAT_ID' };

  const res  = await fetch(
    'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage',
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    },
  );

  const data: any = await res.json();
  if (!data.ok) return { error: 'Telegram API error: ' + (data.description ?? 'unknown') };

  // Persist to D1 for history continuity
  await env.DB
    .prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)')
    .bind(chatId, 'assistant', text, Date.now())
    .run()
    .catch(err => console.error('[sendTelegramMessage] D1 persist failed:', err));

  return { ok: true, messageId: data.result?.message_id };
}