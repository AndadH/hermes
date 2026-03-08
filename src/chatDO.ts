import { DurableObject } from 'cloudflare:workers';
import type { Env, StoredMessage, WsIncoming } from './types';
import { runAgentTurn } from './agent';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ChatDO — one instance per conversation session.
 *
 * Lifecycle:
 *   • Created on first /ws/new connection
 *   • Persists conversation to storage so reconnects restore full history
 *   • Alarm fires after 1 week of inactivity and wipes all storage
 *   • Classic (non-hibernation) WebSocket API so the stop flag works mid-stream
 */
export class ChatDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Classic WebSocket pair — gives us in-memory stop flag that works during streaming
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const sessionId = this.ctx.id.toString();

    // First thing client receives — so it knows which sessionId to store
    server.send(JSON.stringify({ type: 'ready', sessionId }));

    // Refresh the cleanup alarm on every new connection
    await this.ctx.storage.setAlarm(Date.now() + ONE_WEEK_MS);

    // In-memory stop flag. Because JS is single-threaded but async, setting
    // this flag in one event listener IS visible between await points in another.
    let stopRequested = false;

    // ── Message handler ───────────────────────────────────────────────────────
    server.addEventListener('message', async (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;

      let parsed: WsIncoming;
      try {
        parsed = JSON.parse(event.data) as WsIncoming;
      } catch {
        server.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      // ── Stop signal ────────────────────────────────────────────────────────
      if (parsed.type === 'stop') {
        stopRequested = true;
        return;
      }

      // ── New user message ───────────────────────────────────────────────────
      if (parsed.type === 'message' && parsed.content?.trim()) {
        stopRequested = false;

        // Load full history (allows reconnecting devices to resume context)
        const messages: StoredMessage[] =
          (await this.ctx.storage.get<StoredMessage[]>('messages')) ?? [];

        messages.push({
          role: 'user',
          content: parsed.content.trim(),
          timestamp: Date.now(),
        });

        // Persist user message immediately (safe even if generation is interrupted)
        await this.ctx.storage.put('messages', messages);

        try {
          const assistantContent = await runAgentTurn(
            this.env,
            server as unknown as WebSocket,
            messages,
            parsed.activeNote ?? '',
            () => stopRequested,
          );

          // Only persist if we got a real response (not stopped mid-stream)
          if (assistantContent) {
            messages.push({
              role: 'assistant',
              content: assistantContent,
              timestamp: Date.now(),
            });
            await this.ctx.storage.put('messages', messages);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[ChatDO] Agent error:', msg);
          server.send(JSON.stringify({
            type: 'error',
            message: `Generation failed: ${msg}`,
          }));
        }

        // Refresh TTL on every activity
        await this.ctx.storage.setAlarm(Date.now() + ONE_WEEK_MS);
      }
    });

    // ── Close / error ─────────────────────────────────────────────────────────
    server.addEventListener('close', () => {
      stopRequested = true;
    });

    server.addEventListener('error', () => {
      stopRequested = true;
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Fires after ONE_WEEK_MS of inactivity.
   * Wipes all conversation storage — DO is fully ephemeral.
   */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}