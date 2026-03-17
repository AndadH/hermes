// src/durable/timerDO.ts
import { DurableObject } from 'cloudflare:workers';
import { DynamicWorkerExecutor, normalizeCode } from '@cloudflare/codemode';
import type { Env, TimerState, AgentContext } from '../types';
import { buildToolRegistry } from '../tools/registry';
import { runAutonomousTurn } from '../agent/autonomous';

export class TimerDO extends DurableObject<Env> {

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/start')  return this.handleStart(request);
    if (request.method === 'POST' && url.pathname === '/cancel') return this.handleCancel();
    if (request.method === 'GET'  && url.pathname === '/status') return this.handleStatus();
    return new Response('Not found', { status: 404 });
  }

  // ─── Alarm ───────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<TimerState>('state');
    if (!state) return;

    if (state.depth >= state.maxDepth) {
      await this.notifyGaveUp(state, 'reached max depth (' + state.depth + '/' + state.maxDepth + ')');
      await this.cleanup();
      return;
    }

    await this.cleanup();

    if (state.mode === 'intent') {
      await runAutonomousTurn(
        this.env,
        state.intent,
        { depth: state.depth + 1, maxDepth: state.maxDepth, originTs: state.originTs },
        'timer:' + state.id,
        state.context ?? [],
      );
    } else {
      await this.fireCode(state);
    }
  }

  // ─── Code mode fire ───────────────────────────────────────────────────────

  private async fireCode(state: Extract<TimerState, { mode: 'code' }>): Promise<void> {
    const ctx: AgentContext = {
      messages: [],
      platform: 'telegram',
      metadata: {
        budget: {
          depth:    state.depth + 1,
          maxDepth: state.maxDepth,
          originTs: state.originTs,
        },
        // No chatId — tools read env.TELEGRAM_CHAT_ID directly
      },
    };

    const registry = buildToolRegistry(this.env, ctx);
    const toolFns: Record<string, (...a: unknown[]) => Promise<unknown>> = Object.fromEntries(
      Object.entries(registry).map(([name, t]) => [
        name,
        (args: unknown) => t.execute(args as Record<string, unknown>, this.env, ctx),
      ]),
    );

    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER, timeout: 30_000 });
    const { error, logs } = await executor.execute(normalizeCode(state.code), toolFns);

    if (logs?.length) console.log('[TimerDO:' + state.id + '] logs:', logs.join('\n'));

    if (error) {
      console.error('[TimerDO:' + state.id + '] code error:', error);
      await this.sendDM(
        '⚠️ *Scheduled task failed*\n\n*Task:* ' + (state.label ?? state.id) + '\n*Error:* `' + error + '`',
      );
    }
  }

  // ─── Handlers ────────────────────────────────────────────────────────────

  private async handleStart(request: Request): Promise<Response> {
    const state = await request.json<TimerState>();

    if (
      !state.id || !state.mode              ||
      typeof state.minutes  !== 'number'    ||
      typeof state.depth    !== 'number'    ||
      typeof state.maxDepth !== 'number'    ||
      typeof state.originTs !== 'number'
    ) {
      return new Response('Invalid timer state', { status: 400 });
    }

    if (state.mode === 'intent' && !state.intent?.trim()) {
      return new Response('intent required for mode=intent', { status: 400 });
    }
    if (state.mode === 'code' && !state.code?.trim()) {
      return new Response('code required for mode=code', { status: 400 });
    }
    if (state.minutes <= 0) {
      return new Response('minutes must be > 0', { status: 400 });
    }
    if (state.depth >= state.maxDepth) {
      return new Response('depth ' + state.depth + ' >= maxDepth ' + state.maxDepth, { status: 422 });
    }

    await this.ctx.storage.put('state', state);
    await this.ctx.storage.setAlarm(Date.now() + state.minutes * 60_000);

    console.log(
      '[TimerDO:' + state.id + '] armed (' + state.mode + ') — fires in ' + state.minutes + ' min ' +
      '(depth ' + state.depth + '/' + state.maxDepth + ', ' +
      'context specs: ' + (state.context?.length ?? 0) + ')',
    );

    return Response.json({ ok: true });
  }

  private async handleCancel(): Promise<Response> {
    const state = await this.ctx.storage.get<TimerState>('state');
    if (state) console.log('[TimerDO:' + state.id + '] cancelled');
    await this.cleanup();
    return Response.json({ ok: true });
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.ctx.storage.get<TimerState>('state');
    if (!state) return Response.json({ pending: false });
    const alarm = await this.ctx.storage.getAlarm();
    return Response.json({
      pending:  true,
      mode:     state.mode,
      id:       state.id,
      firesAt:  alarm,
      depth:    state.depth,
      maxDepth: state.maxDepth,
      context:  state.context ?? [],
      ...(state.mode === 'intent' ? { intent: state.intent } : { label: state.label }),
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async notifyGaveUp(state: TimerState, reason: string): Promise<void> {
    const label = state.mode === 'code' ? (state.label ?? state.id) : state.id;
    console.warn('[TimerDO:' + state.id + '] giving up — ' + reason);
    await this.sendDM('⚠️ *Hermes gave up on a scheduled task*\n\n*Task:* ' + label + '\n*Reason:* ' + reason);
  }

  private async sendDM(text: string): Promise<void> {
    await fetch('https://api.telegram.org/bot' + this.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    this.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }),
    }).catch(err => console.error('[TimerDO] sendDM failed:', err));
  }

  private async cleanup(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('state');
  }
}