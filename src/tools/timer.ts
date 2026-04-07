// src/tools/timer.ts
import type { Env, AgentContext, TimerState, RecursionBudget, ContextSpec } from '../types';

export const timerDeclarations = [
  {
    name: 'scheduleTimer',
    description:
      'Schedule an autonomous agent turn after a delay. ' +
      'At fire time a fresh agent runs with full tool access and executes the intent. ' +
      'Works from any context — Telegram, Obsidian, or another autonomous turn. ' +
      'Use scheduleCode instead for deterministic actions (no LLM at fire time).',
    parameters: {
      type: 'OBJECT',
      properties: {
        minutes: {
          type: 'NUMBER',
          description: 'Minutes to wait before firing. Must be > 0.',
        },
        intent: {
          type: 'STRING',
          description:
            'Complete self-contained instruction for the agent that wakes up. ' +
            'Include all context, names, and what to do. ' +
            'The agent also has getHistory and all tools available to pull more context mid-run.',
        },
        context: {
          type: 'ARRAY',
          description:
            'Optional. Declare what context to pre-load when the timer fires — ' +
            'these are resolved before the agent runs so it starts with relevant grounding. ' +
            'Each entry is one of:\n' +
            '  { source: "telegram", limit?: number }       — recent Telegram messages\n' +
            '  { source: "vault", path: string }            — a specific vault note\n' +
            '  { source: "history", query: string, limit? } — FTS search across chat history\n' +
            '  { source: "calendar", timeMin?, timeMax? }   — upcoming calendar events\n' +
            'The agent can also call getHistory mid-run for anything not declared here.',
          items: { type: 'OBJECT' },
        },
        id: {
          type: 'STRING',
          description: 'Optional ID. UUID if omitted. Use a slug if you may want to cancel.',
        },
        maxDepth: {
          type: 'NUMBER',
          description: 'Max recursive reschedules. Default 5. Ignored inside an autonomous turn.',
        },
      },
      required: ['minutes', 'intent'],
    },
  },
  {
    name: 'scheduleCode',
    description:
      'Schedule a JavaScript snippet to run after a delay — no LLM call at fire time. ' +
      'Use when the action is deterministic. ' +
      'The code runs in the codemode sandbox with full tool access via codemode.toolName(args). ' +
      'Works from any context — Telegram, Obsidian, or another autonomous turn.',
    parameters: {
      type: 'OBJECT',
      properties: {
        minutes: {
          type: 'NUMBER',
          description: 'Minutes to wait. Must be > 0.',
        },
        code: {
          type: 'STRING',
          description: 'JS async arrow function body. Call tools via `await codemode.toolName(args)`.',
        },
        label: {
          type: 'STRING',
          description: 'Short description — shown in error notifications. Recommended.',
        },
        id: {
          type: 'STRING',
          description: 'Optional ID. UUID if omitted.',
        },
        maxDepth: {
          type: 'NUMBER',
          description: 'Max recursive reschedules. Default 5. Ignored inside an autonomous turn.',
        },
      },
      required: ['minutes', 'code'],
    },
  },
  {
    name: 'cancelTimer',
    description: 'Cancel a pending intent-timer. No-op if already fired.',
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING', description: 'Timer ID from scheduleTimer.' } },
      required: ['id'],
    },
  },
  {
    name: 'cancelCode',
    description: 'Cancel a pending code-timer. No-op if already fired.',
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING', description: 'Timer ID from scheduleCode.' } },
      required: ['id'],
    },
  },
];

// ── Shared helpers ────────────────────────────────────────────────────────────

function resolveId(args: Record<string, unknown>): string {
  return String(args.id ?? crypto.randomUUID());
}

// 3 years in minutes — scheduling beyond this is almost certainly a model mistake
const MAX_SCHEDULE_MINUTES = 3 * 365 * 24 * 60; // 1,576,800

export function resolveBudget(
  args: Record<string, unknown>,
  ctx:  AgentContext,
): { depth: number; maxDepth: number; originTs: number } | { error: string } {
  const budget   = ctx.metadata.budget as RecursionBudget | undefined;
  const depth    = budget?.depth    ?? 0;
  const maxDepth = budget?.maxDepth ?? Number(args.maxDepth ?? 5);
  const originTs = budget?.originTs ?? Date.now();

  if (depth >= maxDepth) return { error: 'Recursion limit: depth ' + depth + ' >= maxDepth ' + maxDepth };

  return { depth, maxDepth, originTs };
}

function getStub(env: Env, prefix: 'timer' | 'codetimer', id: string) {
  return env.TIMER_DO.get(env.TIMER_DO.idFromName(prefix + ':' + id));
}

export function formatFiresAt(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toLocaleString('en-US', {
    timeZone: 'America/Denver',
    hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric',
  });
}

// ── Executors ─────────────────────────────────────────────────────────────────

export async function executeScheduleTimer(
  args: Record<string, unknown>,
  env:  Env,
  ctx:  AgentContext,
): Promise<unknown> {
  const minutes = Number(args.minutes);
  const intent  = String(args.intent ?? '').trim();

  if (!Number.isFinite(minutes) || minutes <= 0) return { error: 'minutes must be > 0' };
  if (minutes > MAX_SCHEDULE_MINUTES) {
    return { error: 'Cannot schedule more than 3 years out (' + MAX_SCHEDULE_MINUTES + ' min). Did you make a unit mistake?' };
  }
  if (!intent) return { error: 'intent is required' };

  const budget = resolveBudget(args, ctx);
  if ('error' in budget) return budget;

  // Validate and extract context specs if provided
  const rawContext  = args.context;
  const contextSpecs: ContextSpec[] = Array.isArray(rawContext)
    ? (rawContext as ContextSpec[])
    : [];

  const id    = resolveId(args);
  const state: TimerState = { mode: 'intent', id, intent, minutes, ...budget, context: contextSpecs };

  const stub = getStub(env, 'timer', id);
  const res  = await stub.fetch(new Request('https://timer-do/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state),
  }));

  if (!res.ok) return { error: 'Failed to arm timer: ' + await res.text() };

  return {
    ok:      true,
    id,
    firesIn: minutes + ' min',
    firesAt: formatFiresAt(minutes),
    budget,
    context: contextSpecs.length > 0 ? contextSpecs.length + ' context spec(s) declared' : 'none',
  };
}

export async function executeScheduleCode(
  args: Record<string, unknown>,
  env:  Env,
  ctx:  AgentContext,
): Promise<unknown> {
  const minutes = Number(args.minutes);
  const code    = String(args.code ?? '').trim();
  const label   = args.label ? String(args.label).trim() : undefined;

  if (!Number.isFinite(minutes) || minutes <= 0) return { error: 'minutes must be > 0' };
  if (minutes > MAX_SCHEDULE_MINUTES) {
    return { error: 'Cannot schedule more than 3 years out (' + MAX_SCHEDULE_MINUTES + ' min). Did you make a unit mistake?' };
  }
  if (!code) return { error: 'code is required' };

  const budget = resolveBudget(args, ctx);
  if ('error' in budget) return budget;

  const id    = resolveId(args);
  const state: TimerState = { mode: 'code', id, code, label, minutes, ...budget };

  const stub = getStub(env, 'codetimer', id);
  const res  = await stub.fetch(new Request('https://timer-do/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state),
  }));

  if (!res.ok) return { error: 'Failed to arm code-timer: ' + await res.text() };

  return { ok: true, id, label: label ?? '(unlabelled)', firesIn: minutes + ' min', firesAt: formatFiresAt(minutes), budget };
}

export async function executeCancelTimer(args: Record<string, unknown>, env: Env): Promise<unknown> {
  const id = String(args.id ?? '').trim();
  if (!id) return { error: 'id is required' };
  await getStub(env, 'timer', id)
    .fetch(new Request('https://timer-do/cancel', { method: 'POST' }))
    .catch(() => {});
  return { ok: true, id };
}

export async function executeCancelCode(args: Record<string, unknown>, env: Env): Promise<unknown> {
  const id = String(args.id ?? '').trim();
  if (!id) return { error: 'id is required' };
  await getStub(env, 'codetimer', id)
    .fetch(new Request('https://timer-do/cancel', { method: 'POST' }))
    .catch(() => {});
  return { ok: true, id };
}