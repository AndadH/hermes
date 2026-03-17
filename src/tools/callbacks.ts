// src/tools/callbacks.ts
import type { Env, AgentContext, CallbackEntry, CallbackTrigger, RecursionBudget, ContextSpec } from '../types';

function getCallbackStub(env: Env) {
  return env.CALLBACK_DO.get(env.CALLBACK_DO.idFromName('callbacks'));
}

export const callbackDeclarations = [
  {
    name: 'registerCallback',
    description:
      'Register a trigger so Hermes runs an autonomous task when a Telegram event occurs. ' +
      'Works from any context — Telegram, Obsidian, or another autonomous turn.\n\n' +
      'Trigger types:\n' +
      '  telegram:message  — fires when an incoming message matches a JS regex (case-insensitive)\n' +
      '  telegram:reaction — fires when an emoji reaction is added to a message\n\n' +
      'Default: one-shot (auto-deletes after first fire). Set persistent: true to keep firing.',
    parameters: {
      type: 'OBJECT',
      properties: {
        triggerType: {
          type: 'STRING',
          description: '"telegram:message" or "telegram:reaction"',
        },
        pattern: {
          type: 'STRING',
          description: 'For telegram:message: JS regex string (case-insensitive). Example: "approved|lgtm"',
        },
        emoji: {
          type: 'STRING',
          description: 'For telegram:reaction: specific emoji to match. Omit for any emoji.',
        },
        messageId: {
          type: 'NUMBER',
          description: 'For telegram:reaction: restrict to a specific Telegram message ID. Omit for any message.',
        },
        intent: {
          type: 'STRING',
          description: 'Complete self-contained instruction for the agent when the trigger fires.',
        },
        context: {
          type: 'ARRAY',
          description:
            'Optional. Context specs to pre-load when the callback fires. Same format as scheduleTimer context. ' +
            'Each entry: { source: "telegram"|"vault"|"history"|"calendar", ...options }',
          items: { type: 'OBJECT' },
        },
        id: {
          type: 'STRING',
          description: 'Optional ID. UUID if omitted.',
        },
        persistent: {
          type: 'BOOLEAN',
          description: 'Keep firing after first trigger. Default false.',
        },
        maxDepth: {
          type: 'NUMBER',
          description: 'Max autonomous reschedules. Default 5.',
        },
      },
      required: ['triggerType', 'intent'],
    },
  },
  {
    name: 'deleteCallback',
    description: 'Delete a registered callback by ID. Safe to call even if already fired.',
    parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING', description: 'Callback ID from registerCallback.' } },
      required: ['id'],
    },
  },
  {
    name: 'listCallbacks',
    description: 'List all currently registered callbacks with their triggers, intents, and budgets.',
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
];

export async function executeRegisterCallback(
  args: Record<string, unknown>,
  env:  Env,
  ctx:  AgentContext,
): Promise<unknown> {
  const triggerType = String(args.triggerType ?? '');
  const intent      = String(args.intent ?? '').trim();

  if (!intent) return { error: 'intent is required' };
  if (triggerType !== 'telegram:message' && triggerType !== 'telegram:reaction') {
    return { error: 'triggerType must be "telegram:message" or "telegram:reaction"' };
  }

  let trigger: CallbackTrigger;
  if (triggerType === 'telegram:message') {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) return { error: 'pattern is required for telegram:message trigger' };
    try { new RegExp(pattern); } catch (e) { return { error: 'Invalid regex: ' + (e as Error).message }; }
    trigger = { type: 'telegram:message', pattern };
  } else {
    trigger = {
      type:      'telegram:reaction',
      emoji:     args.emoji     ? String(args.emoji)   : undefined,
      messageId: args.messageId ? Number(args.messageId) : undefined,
    };
  }

  const budget        = ctx.metadata.budget as RecursionBudget | undefined;
  const depth         = budget?.depth    ?? 0;
  const maxDepth      = budget?.maxDepth ?? Number(args.maxDepth ?? 5);
  const originTs      = budget?.originTs ?? Date.now();

  if (depth >= maxDepth) return { error: 'Recursion limit: depth ' + depth + ' >= maxDepth ' + maxDepth };
  const ageMs = Date.now() - originTs;

  const contextSpecs: ContextSpec[] = Array.isArray(args.context)
    ? (args.context as ContextSpec[])
    : [];

  const id         = String(args.id ?? crypto.randomUUID());
  const persistent = Boolean(args.persistent ?? false);

  const entry: CallbackEntry = {
    id, trigger, intent,
    createdAt: Date.now(),
    persistent,
    context: contextSpecs,
    depth, maxDepth, originTs,
  };

  const stub = getCallbackStub(env);
  const res  = await stub.fetch(new Request('https://callback-do/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
  }));

  if (!res.ok) return { error: 'Failed to register callback: ' + await res.text() };

  return { ok: true, id, trigger, persistent, budget: { depth, maxDepth } };
}

export async function executeDeleteCallback(args: Record<string, unknown>, env: Env): Promise<unknown> {
  const id = String(args.id ?? '').trim();
  if (!id) return { error: 'id is required' };
  const stub = getCallbackStub(env);
  const res  = await stub.fetch(new Request('https://callback-do/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  }));
  if (!res.ok) return { error: await res.text() };
  return res.json();
}

export async function executeListCallbacks(env: Env): Promise<unknown> {
  const stub = getCallbackStub(env);
  const res  = await stub.fetch(new Request('https://callback-do/list'));
  if (!res.ok) return { error: await res.text() };
  return res.json();
}