// src/tools/registry.ts
import type { Env, AgentContext, SearchResult } from '../types';

import {
  vaultDeclarations,
  executeSearchVault,
  executeListNotes,
  executeReadNote,
  executeCreateNote,
  executeEditNote,
  executePatchNote,
  executeDeleteNote,
} from './vault';

import { webDeclarations, executeWebSearch, executeFetchPage } from './web';

import {
  calendarDeclarations,
  executeGetCalendarEvents,
  executeCreateCalendarEvent,
} from './calendar';

import { historyDeclarations, executeSearchChatHistory, executeGetHistory } from './history';

import {
  timerDeclarations,
  executeScheduleTimer,
  executeScheduleCode,
  executeCancelTimer,
  executeCancelCode,
} from './timer';

import {
  callbackDeclarations,
  executeRegisterCallback,
  executeDeleteCallback,
  executeListCallbacks,
} from './callbacks';

import { telegramDeclarations, executeSendTelegramMessage } from './telegram';

// ── ToolDef ───────────────────────────────────────────────────────────────────

export interface ToolDef {
  description: string;
  geminiDeclaration: Record<string, unknown>;
  execute: (args: Record<string, unknown>, env: Env, ctx: AgentContext) => Promise<unknown>;
  sideEffect?: boolean;
  // ── Spec fields — used by buildToolSpec / discoverTools ───────────────────
  tags:      string[];   // semantic vocabulary for filtering, never sent to model raw
  returns:   string;     // one-line return shape description, useful for chaining
  skill?:    string;     // usage guide, only on complex tools
  examples?: string[];   // 1-2 codemode call examples, only where non-obvious
}

// ── Skill strings ─────────────────────────────────────────────────────────────

const TIMER_SKILL = [
  'scheduleTimer fires a full autonomous agent turn after the delay.',
  'The agent re-reasons at fire time with full tool access.',
  'Use when you need to evaluate the situation fresh at fire time.',
  'Write intent as a complete self-contained briefing — the future agent has no other context.',
  'Budget (depth/maxDepth) is forwarded automatically when rescheduling.',
  'Default budget: maxDepth 5, maxDepth 5.',
  'Use scheduleCode instead when the action is deterministic.',
].join('\n');

const CODE_TIMER_SKILL = [
  'scheduleCode runs a JS snippet after a delay with NO LLM call at fire time.',
  'Use when the action is fully deterministic — you know exactly what to do right now.',
  'The code runs in the same codemode sandbox with full tool access.',
  'Code is frozen at scheduling time — it cannot adapt to new information.',
  'Always set label — it appears in error/give-up notifications.',
  'Use scheduleTimer instead when you need to re-evaluate at fire time.',
].join('\n');

const CALLBACK_SKILL = [
  'registerCallback fires an autonomous agent turn when a Telegram event occurs.',
  '',
  'telegram:message — fires when an incoming message matches a JS regex (case-insensitive):',
  '  { triggerType: "telegram:message", pattern: "approved|lgtm", intent: "..." }',
  '',
  'telegram:reaction — fires when an emoji reaction is added:',
  '  { triggerType: "telegram:reaction", emoji: "👍", messageId: 123, intent: "..." }',
  '  Omit emoji to match any. Omit messageId to match reactions on any message.',
  '',
  'Default: one-shot (auto-deletes after first fire). Set persistent: true to keep firing.',
  'Write intent as a complete self-contained briefing — same rules as scheduleTimer.',
].join('\n');

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildToolRegistry(env: Env, ctx: AgentContext): Record<string, ToolDef> {
  return {

    // ── Vault ────────────────────────────────────────────────────────────────

    searchVault: {
      description: vaultDeclarations.find(d => d.name === 'searchVault')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'searchVault')!,
      tags:    ['vault', 'search', 'notes', 'obsidian', 'find', 'semantic', 'query', 'lookup'],
      returns: '{ results: { filename: string, score: number, excerpt: string }[] }',
      execute: async (args) => {
        const results = await executeSearchVault(env, ctx, String(args.query ?? ''));
        return { results: results.map((r: SearchResult) => ({ filename: r.filename, score: r.score, excerpt: r.excerpt })) };
      },
    },

    listNotes: {
      description: vaultDeclarations.find(d => d.name === 'listNotes')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'listNotes')!,
      tags:    ['vault', 'list', 'notes', 'directory', 'folder', 'browse', 'all'],
      returns: '{ notes: string[] }',
      execute: async (args) => executeListNotes(env, ctx, args.folder ? String(args.folder) : undefined),
    },

    readNote: {
      description: vaultDeclarations.find(d => d.name === 'readNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'readNote')!,
      tags:    ['vault', 'read', 'note', 'content', 'get', 'fetch', 'open'],
      returns: '{ content: string } | { error: string }',
      execute: async (args) => executeReadNote(env, ctx, String(args.path ?? '')),
    },

    createNote: {
      description: vaultDeclarations.find(d => d.name === 'createNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'createNote')!,
      tags:    ['vault', 'create', 'write', 'new', 'note', 'add'],
      returns: '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executeCreateNote(env, ctx, String(args.path ?? ''), String(args.content ?? '')),
    },

    editNote: {
      description: vaultDeclarations.find(d => d.name === 'editNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'editNote')!,
      tags:    ['vault', 'edit', 'update', 'overwrite', 'note', 'write', 'replace'],
      returns: '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executeEditNote(env, ctx, String(args.path ?? ''), String(args.content ?? '')),
    },

    patchNote: {
      description: vaultDeclarations.find(d => d.name === 'patchNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'patchNote')!,
      tags:    ['vault', 'patch', 'edit', 'surgical', 'find-replace', 'note', 'small-change'],
      returns: '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executePatchNote(env, ctx, String(args.path ?? ''), String(args.find ?? ''), String(args.replace ?? '')),
    },

    deleteNote: {
      description: vaultDeclarations.find(d => d.name === 'deleteNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'deleteNote')!,
      tags:    ['vault', 'delete', 'remove', 'note', 'destroy'],
      returns: '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executeDeleteNote(env, ctx, String(args.path ?? '')),
    },

    // ── Web ──────────────────────────────────────────────────────────────────

    webSearch: {
      description: webDeclarations.find(d => d.name === 'webSearch')!.description,
      geminiDeclaration: webDeclarations.find(d => d.name === 'webSearch')!,
      tags:    ['web', 'search', 'internet', 'current', 'news', 'online', 'tavily', 'external', 'lookup'],
      returns: '{ results: { title: string, url: string, snippet: string }[] }',
      execute: async (args) => {
        const results = await executeWebSearch(env, String(args.query ?? ''));
        return { results };
      },
    },

    fetchPage: {
      description: webDeclarations.find(d => d.name === 'fetchPage')!.description,
      geminiDeclaration: webDeclarations.find(d => d.name === 'fetchPage')!,
      tags:    ['web', 'fetch', 'read', 'url', 'page', 'scrape', 'content', 'full-text'],
      returns: '{ content: string } | { error: string }',
      execute: async (args) => executeFetchPage(ctx, String(args.url ?? '')),
    },

    // ── Calendar ─────────────────────────────────────────────────────────────

    getCalendarEvents: {
      description: calendarDeclarations.find(d => d.name === 'getCalendarEvents')!.description,
      geminiDeclaration: calendarDeclarations.find(d => d.name === 'getCalendarEvents')!,
      tags:    ['calendar', 'events', 'schedule', 'availability', 'meetings', 'appointments', 'busy'],
      returns: '{ events: { summary: string, start: string, end: string, description?: string }[] }',
      execute: async (args) => executeGetCalendarEvents(env, ctx, {
        timeMin: args.timeMin ? String(args.timeMin) : undefined,
        timeMax: args.timeMax ? String(args.timeMax) : undefined,
      }),
    },

    createCalendarEvent: {
      description: calendarDeclarations.find(d => d.name === 'createCalendarEvent')!.description,
      geminiDeclaration: calendarDeclarations.find(d => d.name === 'createCalendarEvent')!,
      tags:    ['calendar', 'create', 'book', 'event', 'meeting', 'schedule', 'add', 'appointment'],
      returns: '{ success: boolean, eventId?: string } | { error: string }',
      sideEffect: true,
      execute: async (args) => {
        const summary = String(args.summary ?? args.title ?? args.name ?? args.subject ?? '').trim();
        if (!summary) return { success: false, error: 'Missing event title. Provide field as "summary".' };
        return executeCreateCalendarEvent(env, ctx, {
          summary,
          startTime:   String(args.startTime ?? ''),
          endTime:     String(args.endTime ?? ''),
          description: args.description ? String(args.description) : undefined,
        });
      },
    },

    // ── History ──────────────────────────────────────────────────────────────

    searchChatHistory: {
      description: historyDeclarations.find(d => d.name === 'searchChatHistory')!.description,
      geminiDeclaration: historyDeclarations.find(d => d.name === 'searchChatHistory')!,
      tags:    ['history', 'chat', 'past', 'search', 'previous', 'conversation', 'messages', 'recall'],
      returns: '{ results: { role: string, content: string, timestamp: number }[] }',
      execute: async (args) => executeSearchChatHistory(env, ctx, String(args.query ?? '')),
    },

    getHistory: {
      description: historyDeclarations.find(d => d.name === 'getHistory')!.description,
      geminiDeclaration: historyDeclarations.find(d => d.name === 'getHistory')!,
      tags:    ['history', 'context', 'recent', 'fetch', 'telegram', 'messages', 'load'],
      returns: '{ source: string, count: number, messages: { role, content, timestamp }[] }',
      execute: async (args) => executeGetHistory(args, env),
    },

    // ── Timers ───────────────────────────────────────────────────────────────

    scheduleTimer: {
      description: timerDeclarations.find(d => d.name === 'scheduleTimer')!.description,
      geminiDeclaration: timerDeclarations.find(d => d.name === 'scheduleTimer')!,
      tags:    ['async', 'timer', 'delay', 'later', 'remind', 'follow-up', 'check-in', 'wait', 'schedule', 'autonomous', 'agent'],
      returns: '{ ok: boolean, id: string, firesIn: string, firesAt: string, budget: { depth, maxDepth, budget } }',
      skill:   TIMER_SKILL,
      examples: [
        'await codemode.scheduleTimer({ minutes: 20, intent: "Ask over Telegram if the deploy issue is resolved. If yes, log it in Projects/Deploy.md. If not, check again in 30 min (up to 3 more times).", id: "deploy-followup" })',
      ],
      execute: async (args) => executeScheduleTimer(args, env, ctx),
    },

    scheduleCode: {
      description: timerDeclarations.find(d => d.name === 'scheduleCode')!.description,
      geminiDeclaration: timerDeclarations.find(d => d.name === 'scheduleCode')!,
      tags:    ['async', 'code', 'timer', 'delay', 'later', 'deterministic', 'schedule', 'no-llm', 'cheap', 'reminder'],
      returns: '{ ok: boolean, id: string, label: string, firesIn: string, firesAt: string, budget: { depth, maxDepth, budget } }',
      skill:   CODE_TIMER_SKILL,
      examples: [
        'await codemode.scheduleCode({ minutes: 20, label: "remind Andrew", code: `await codemode.sendTelegramMessage({ text: "Reminder: follow up on the deploy" });` })',
        'await codemode.scheduleCode({ minutes: 60, label: "log standup", code: `const note = await codemode.readNote({ path: "Daily/Standup.md" }); await codemode.editNote({ path: "Daily/Standup.md", content: note.content + "\\n- Checked in at " + new Date().toISOString() });` })',
      ],
      execute: async (args) => executeScheduleCode(args, env, ctx),
    },

    cancelTimer: {
      description: timerDeclarations.find(d => d.name === 'cancelTimer')!.description,
      geminiDeclaration: timerDeclarations.find(d => d.name === 'cancelTimer')!,
      tags:    ['async', 'timer', 'cancel', 'stop', 'abort', 'remove'],
      returns: '{ ok: boolean, id: string }',
      execute: async (args) => executeCancelTimer(args, env),
    },

    cancelCode: {
      description: timerDeclarations.find(d => d.name === 'cancelCode')!.description,
      geminiDeclaration: timerDeclarations.find(d => d.name === 'cancelCode')!,
      tags:    ['async', 'code', 'timer', 'cancel', 'stop', 'abort', 'remove'],
      returns: '{ ok: boolean, id: string }',
      execute: async (args) => executeCancelCode(args, env),
    },

    // ── Callbacks ────────────────────────────────────────────────────────────

    registerCallback: {
      description: callbackDeclarations.find(d => d.name === 'registerCallback')!.description,
      geminiDeclaration: callbackDeclarations.find(d => d.name === 'registerCallback')!,
      tags:    ['async', 'callback', 'trigger', 'reaction', 'message', 'watch', 'telegram', 'event', 'on', 'listen', 'wait-for'],
      returns: '{ ok: boolean, id: string, trigger, persistent: boolean, budget: { depth, maxDepth, budget } }',
      skill:   CALLBACK_SKILL,
      examples: [
        'await codemode.registerCallback({ triggerType: "telegram:message", pattern: "approved|lgtm|ship it", intent: "The user just approved something. Search the vault for the most recent pending decision, mark it approved, confirm to user.", id: "watch-approval" })',
        'await codemode.registerCallback({ triggerType: "telegram:reaction", emoji: "👍", messageId: 42, intent: "User thumbs-upped my proposal. Create a calendar event for the kickoff meeting tomorrow at 10am.", id: "thumbsup-42" })',
      ],
      execute: async (args) => executeRegisterCallback(args, env, ctx),
    },

    deleteCallback: {
      description: callbackDeclarations.find(d => d.name === 'deleteCallback')!.description,
      geminiDeclaration: callbackDeclarations.find(d => d.name === 'deleteCallback')!,
      tags:    ['async', 'callback', 'delete', 'remove', 'cancel', 'unregister'],
      returns: '{ ok: boolean, existed: boolean }',
      execute: async (args) => executeDeleteCallback(args, env),
    },

    listCallbacks: {
      description: callbackDeclarations.find(d => d.name === 'listCallbacks')!.description,
      geminiDeclaration: callbackDeclarations.find(d => d.name === 'listCallbacks')!,
      tags:    ['async', 'callback', 'list', 'active', 'pending', 'registered', 'all'],
      returns: '{ callbacks: { id, trigger, intent, persistent, depth, maxDepth }[] }',
      execute: async () => executeListCallbacks(env),
    },

    // ── Telegram ─────────────────────────────────────────────────────────────

    sendTelegramMessage: {
      description: telegramDeclarations.find(d => d.name === 'sendTelegramMessage')!.description,
      geminiDeclaration: telegramDeclarations.find(d => d.name === 'sendTelegramMessage')!,
      tags:    ['telegram', 'message', 'send', 'notify', 'proactive', 'dm', 'chat', 'reply'],
      returns: '{ ok: boolean, messageId: number } | { error: string }',
      execute: async (args) => executeSendTelegramMessage(args, env, ctx),
    },
  };
}

export function getAllDeclarations(registry: Record<string, ToolDef>): Record<string, unknown>[] {
  return Object.values(registry).map((t) => t.geminiDeclaration);
}