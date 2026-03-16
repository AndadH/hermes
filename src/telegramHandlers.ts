import type { Context } from 'hono';
import type { Env, StoredMessage } from './types';
import { runAgentTurn } from './agent';

const MAX_HISTORY = 10; 
const CONTEXT_EXPIRY_MS = 24 * 60 * 60 * 1000; 
const EDIT_INTERVAL_MS = 1200;

export async function handleTelegramWebhook(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json();
  const message = body.message;

  // Acknowledge non-message updates instantly
  if (!message || !message.text || !message.from) {
    return c.json({ status: 'ignored' });
  }

  // SECURITY: Only allow your specific Telegram User ID
  const allowedUserId = Number(c.env.TELEGRAM_ALLOWED_USER_ID);
  if (message.from.id !== allowedUserId) {
    console.warn(`Unauthorized Telegram access attempt from ID: ${message.from.id}`);
    // Return 200 so Telegram doesn't retry the delivery, but do nothing
    return c.json({ status: 'unauthorized' });
  }

  const chatId = message.chat.id;
  const text = message.text;

  // Process the agent turn in the background to prevent Telegram webhook timeouts
  c.executionCtx.waitUntil(processTelegramMessage(c.env, chatId, text));

  // Immediately tell Telegram we received the message
  return c.json({ status: 'ok' });
}

async function processTelegramMessage(env: Env, chatId: number, text: string) {
  const now = Date.now();
  const cutoffTime = now - CONTEXT_EXPIRY_MS;

  // 1. Load Sliding Window History
  const { results } = await env.DB.prepare(`
    SELECT role, content, timestamp 
    FROM telegram_history 
    WHERE chatId = ? AND timestamp > ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).bind(chatId, cutoffTime, MAX_HISTORY).all<{ role: string; content: string; timestamp: number }>();

  const history: StoredMessage[] = (results ?? []).reverse().map(row => ({
    role: row.role as 'user' | 'assistant',
    content: row.content,
    timestamp: row.timestamp,
  }));
  history.push({ role: 'user', content: text, timestamp: now });

  try {
    // 2. Send Initial Placeholder Message
    const initialRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: 'Thinking...', parse_mode: 'Markdown' }),
    });
    const initialData: any = await initialRes.json();
    const messageId = initialData.result.message_id;

    // 3. Setup UI Update Queue
    let toolLogs = 'Thinking...\n';
    let finalAnswer = ''; 
    let isEditing = false;
    let pendingUpdate = false;

    // 4. Mock the WebSocket with a self-draining queue
    const mockWs = {
      send: (dataString: string) => {
        const payload = JSON.parse(dataString) as any;
        
        if (payload.type === 'token') {
          finalAnswer += payload.content;
        } else if (payload.type === 'toolCall') {
          // Clean, minimalist bullet point format for logs
          toolLogs += `\n- ${payload.label}`;
          
          if (!isEditing) {
            isEditing = true;
            
            // Start the background UI updater loop
            (async () => {
              while (true) {
                try {
                  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: toolLogs, parse_mode: 'Markdown' }),
                  });
                } catch (e) {
                  // Silently ignore rate limits
                }
                
                // Mandatory Telegram cooldown
                await new Promise(r => setTimeout(r, EDIT_INTERVAL_MS));
                
                // If no new tools were called during our cooldown, break the loop
                if (!pendingUpdate) {
                  isEditing = false;
                  break;
                }
                
                // Otherwise, reset the flag and loop again to push the newest logs
                pendingUpdate = false;
              }
            })();
          } else {
            // If the loop is already running, just flag that it needs to run again
            pendingUpdate = true;
          }
        }
      }
    } as unknown as WebSocket;

    // 5. Run the Agent
    const finalContent = await runAgentTurn(env, mockWs, history, '', () => false);

   // 6. Push Final Answer & Save to DB
    const textToSave = finalContent || finalAnswer;
    
    if (textToSave) {
      // WAIT for any trailing tool updates to finish
      while (isEditing) {
        await new Promise(r => setTimeout(r, 200));
      }

      // Robust delivery function with retries and plain-text fallback
      const pushFinalMessage = async (text: string, useMarkdown: boolean, retries = 2) => {
        for (let i = 0; i < retries; i++) {
          const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              chat_id: chatId, 
              message_id: messageId, 
              text: text, 
              parse_mode: useMarkdown ? 'Markdown' : undefined 
            }),
          });
          
          if (res.ok) return true;
          
          const errorData: any = await res.json();
          console.error(`[Telegram] Final edit failed (Attempt ${i+1}):`, errorData);
          
          if (res.status === 429) {
            // Rate limited. Wait the requested time (plus a 500ms safety buffer) and retry.
            const retryAfter = (errorData.parameters?.retry_after || 1) * 1000;
            await new Promise(r => setTimeout(r, retryAfter + 500));
          } else if (res.status === 400 && errorData.description?.includes('parse')) {
            // Markdown parsing error! Fall back to plain text immediately.
            return pushFinalMessage(text, false, 1);
          } else {
            // Other fatal error, stop retrying
            break;
          }
        }
        return false;
      };

      // Attempt to send with Markdown first
      await pushFinalMessage(textToSave, true);
      
      // Save the final exchange to your D1 database
      await env.DB.batch([
        env.DB.prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)').bind(chatId, 'user', text, now),
        env.DB.prepare('INSERT INTO telegram_history (chatId, role, content, timestamp) VALUES (?, ?, ?, ?)').bind(chatId, 'assistant', textToSave, Date.now()),
      ]);
    }
  } catch (err) {
    console.error('[Telegram] Agent error:', err);
    await sendTelegramMessage(env, chatId, 'An error occurred while processing your request.');
  }
}


async function sendTelegramMessage(env: Env, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      chat_id: chatId, 
      text: text, 
      parse_mode: 'Markdown'
    }),
  });
}