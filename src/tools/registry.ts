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
  executeDeleteCalendarEvent,
  executeUpdateCalendarEvent,
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

import {
  dailyDeclarations,
  executeReadMemory,
  executeWriteMemory,
} from './daily';

import {
  mathDeclarations,
  executeNewtonMath,
  executeWolframAlpha,
} from './math';

import {
  researchDeclarations,
  executeOpenAlex,
  executeArxiv,
  executeWikipedia,
  executeFred,
  executeWorldBank,
} from './research';

import {
  entityDeclarations,
  executeFindEntities,
  executeGetEntity,
  executeCreateEntity,
  executeUpdateEntity,
  executeAppendEntityNote,
  executeDeleteEntity,
  executeLinkEntities,
  executeGetRelations,
  executeDefineSchema,
  executeGetSchema,
} from './entities';

// ── ToolDef ───────────────────────────────────────────────────────────────────

export interface ToolDef {
  description:       string;
  geminiDeclaration: Record<string, unknown>;
  execute:           (args: Record<string, unknown>, env: Env, ctx: AgentContext) => Promise<unknown>;
  sideEffect?:       boolean;
  // ── Spec fields — used by buildToolSpec / discoverTools ───────────────────
  category:  string;    // which __index bucket this belongs to
  tags:      string[];  // semantic vocabulary for filtering
  returns:   string;    // one-line return shape description
  note?:     string;    // disambiguation hint vs similar tools
  skill?:    string;    // usage guide, only on complex tools
  examples?: string[];  // 1-2 codemode call examples, only where non-obvious
}

// ── Skill strings ─────────────────────────────────────────────────────────────

const TIMER_SKILL = [
  'scheduleTimer fires a full autonomous agent turn after the delay.',
  'The agent re-reasons at fire time with full tool access.',
  'Use when you need to evaluate the situation fresh at fire time.',
  'Write intent as a complete self-contained briefing — the future agent has no other context.',
  'Budget (depth/maxDepth) is forwarded automatically when rescheduling.',
  'Default budget: maxDepth 5.',
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

const NEWTON_SKILL = [
  'newtonMath wraps the Newton micro-service for symbolic math.',
  '',
  'Operations: simplify | factor | derive | integrate | zeroes | tangent | area |',
  '            cos | sin | tan | arccos | arcsin | arctan | abs | log',
  '',
  'Expression syntax:',
  '  - Use ^ for exponents:               x^2+2x',
  '  - Use (over) for fractions:          1(over)2',
  '  - Tangent line at x=c:               c|f(x)  →  e.g. "2|x^3"',
  '  - Area under curve from c to d:      c:d|f(x) → e.g. "2:4|x^3"',
  '',
  'Use executeCode for pure numeric calculations.',
  'Use wolframAlpha for anything Newton cannot handle (ODEs, series, etc.).',
].join('\n');

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildToolRegistry(env: Env, ctx: AgentContext): Record<string, ToolDef> {
  return {

    // ── Vault ─────────────────────────────────────────────────────────────────
    // Shared collaborative workspace — both Andrew and Hermes read and write here.

    searchVault: {
      description:       vaultDeclarations.find(d => d.name === 'searchVault')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'searchVault')!,
      category: 'vault',
      tags:     ['vault', 'search', 'notes', 'obsidian', 'find', 'semantic', 'query', 'lookup'],
      returns:  '{ results: { filename: string, score: number, excerpt: string }[] }',
      execute: async (args) => {
        const results = await executeSearchVault(env, ctx, String(args.query ?? ''));
        return { results: results.map((r: SearchResult) => ({ filename: r.filename, score: r.score, excerpt: r.excerpt })) };
      },
    },

    listNotes: {
      description:       vaultDeclarations.find(d => d.name === 'listNotes')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'listNotes')!,
      category: 'vault',
      tags:     ['vault', 'list', 'notes', 'directory', 'folder', 'browse', 'all'],
      returns:  '{ notes: string[] }',
      execute: async (args) => executeListNotes(env, ctx, args.folder ? String(args.folder) : undefined),
    },

    readNote: {
      description:       vaultDeclarations.find(d => d.name === 'readNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'readNote')!,
      category: 'vault',
      tags:     ['vault', 'read', 'note', 'content', 'get', 'fetch', 'open'],
      returns:  '{ content: string } | { error: string }',
      execute: async (args) => executeReadNote(env, ctx, String(args.path ?? '')),
    },

    createNote: {
      description:       vaultDeclarations.find(d => d.name === 'createNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'createNote')!,
      category:  'vault',
      tags:      ['vault', 'create', 'write', 'new', 'note', 'add', 'document', 'doc'],
      returns:   '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executeCreateNote(env, ctx, String(args.path ?? ''), String(args.content ?? '')),
    },

    editNote: {
      description:       vaultDeclarations.find(d => d.name === 'editNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'editNote')!,
      category:  'vault',
      tags:      ['vault', 'edit', 'update', 'overwrite', 'note', 'write', 'replace'],
      returns:   '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executeEditNote(env, ctx, String(args.path ?? ''), String(args.content ?? '')),
    },

    patchNote: {
      description:       vaultDeclarations.find(d => d.name === 'patchNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'patchNote')!,
      category:  'vault',
      tags:      ['vault', 'patch', 'edit', 'surgical', 'find-replace', 'note', 'small-change'],
      returns:   '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executePatchNote(env, ctx, String(args.path ?? ''), String(args.find ?? ''), String(args.replace ?? '')),
    },

    deleteNote: {
      description:       vaultDeclarations.find(d => d.name === 'deleteNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'deleteNote')!,
      category:  'vault',
      tags:      ['vault', 'delete', 'remove', 'note', 'destroy'],
      returns:   '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executeDeleteNote(env, ctx, String(args.path ?? '')),
    },

    // ── Memory ────────────────────────────────────────────────────────────────
    // Everything Hermes accumulates — entities, observations, conversation history.
    // history tools (searchChatHistory, getHistory) also live here.

    findEntities: {
      description:       entityDeclarations.find(d => d.name === 'findEntities')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'findEntities')!,
      category: 'memory',
      tags:     [
        // entity types
        'memory', 'entities', 'contacts', 'people', 'person', 'someone', 'anyone',
        'organization', 'company', 'project', 'team', 'group', 'vendor', 'client',
        // relationship language
        'phonebook', 'directory', 'roster', 'crm', 'relationships', 'network',
        'colleague', 'coworker', 'friend', 'partner', 'lead', 'stakeholder',
        // query patterns
        'who', 'know', 'about', 'remember', 'recall', 'find', 'search', 'lookup',
        'stored', 'tracked', 'recorded', 'registered', 'saved', 'logged',
        // action patterns
        'tell me about', 'do i know', 'is there', 'do we have', 'show me', 'list', 'get',
        // professional context
        'engineer', 'researcher', 'manager', 'founder', 'investor', 'advisor',
        'employee', 'contractor', 'customer', 'supplier', 'associate',
      ],
      returns:  '{ total: number, results: { id, type, name, tags, updated_at, excerpt }[] }',
      note:     'Check this whenever a person, organization, or project is mentioned by name — ' +
                'may surface context already accumulated. Also call before createEntity to avoid duplicates.',
      examples: [
        'await codemode.findEntities({ query: "Sarah Acme", type: "contact" })',
        'await codemode.findEntities({ query: "infrastructure EU", limit: 5 })',
        'await codemode.findEntities({ query: "active", type: "project" })',
      ],
      execute: async (args, env) => executeFindEntities(args, env),
    },

    getEntity: {
      description:       entityDeclarations.find(d => d.name === 'getEntity')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'getEntity')!,
      category: 'memory',
      tags:     ['memory', 'entities', 'get', 'read', 'full', 'detail', 'record'],
      returns:  '{ id, type, name, tags, notes, data, created_at, updated_at }',
      examples: [
        'await codemode.getEntity({ id: "uuid-here" })',
      ],
      execute: async (args, env) => executeGetEntity(args, env),
    },

    createEntity: {
      description:       entityDeclarations.find(d => d.name === 'createEntity')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'createEntity')!,
      category:  'memory',
      tags:      ['memory', 'entities', 'create', 'add', 'new', 'contact', 'project', 'book', 'record'],
      returns:   '{ ok: boolean, id: string, type: string, name: string }',
      sideEffect: true,
      examples: [
        'await codemode.createEntity({ type: "contact", name: "Sarah Chen", data: JSON.stringify({ email: "sarah@acme.com", organization: "Acme", role: "VP Engineering" }), note: "Met at Denver tech meetup" })',
        'await codemode.createEntity({ type: "project", name: "EU Expansion", tags: "active,q2", data: JSON.stringify({ status: "active", deadline: "2025-06-01" }) })',
      ],
      execute: async (args, env) => executeCreateEntity(args, env),
    },

    updateEntity: {
      description:       entityDeclarations.find(d => d.name === 'updateEntity')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'updateEntity')!,
      category:  'memory',
      tags:      ['memory', 'entities', 'update', 'edit', 'patch', 'change'],
      returns:   '{ ok: boolean, id: string, updated: string[] }',
      sideEffect: true,
      examples: [
        'await codemode.updateEntity({ id: "uuid", data: JSON.stringify({ role: "CTO" }) })',
        'await codemode.updateEntity({ id: "uuid", name: "Sarah Chen-Williams", tags: "vip,investor" })',
      ],
      execute: async (args, env) => executeUpdateEntity(args, env),
    },

    appendEntityNote: {
      description:       entityDeclarations.find(d => d.name === 'appendEntityNote')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'appendEntityNote')!,
      category:  'memory',
      tags:      ['memory', 'entities', 'note', 'append', 'log', 'observe', 'remember', 'context'],
      returns:   '{ ok: boolean, id: string, entry: string }',
      sideEffect: true,
      note:      'Prefer this over updateEntity for adding observations — never overwrites, ' +
                 'always appends with a timestamp. This is what makes the store grow over time.',
      examples: [
        'await codemode.appendEntityNote({ id: "uuid", note: "Mentioned EU expansion plans during vendor discussion" })',
        'await codemode.appendEntityNote({ id: "uuid", note: "Introduced me to James on their infrastructure team" })',
      ],
      execute: async (args, env) => executeAppendEntityNote(args, env),
    },

    deleteEntity: {
      description:       entityDeclarations.find(d => d.name === 'deleteEntity')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'deleteEntity')!,
      category:  'memory',
      tags:      ['memory', 'entities', 'delete', 'remove', 'destroy'],
      returns:   '{ ok: boolean, id: string, deleted: boolean }',
      sideEffect: true,
      execute: async (args, env) => executeDeleteEntity(args, env),
    },

    linkEntities: {
      description:       entityDeclarations.find(d => d.name === 'linkEntities')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'linkEntities')!,
      category:  'memory',
      tags:      ['memory', 'entities', 'link', 'relate', 'relationship', 'edge', 'graph', 'connect'],
      returns:   '{ ok: boolean, id: string, from, relation, to }',
      sideEffect: true,
      examples: [
        'await codemode.linkEntities({ from_id: "sarah-uuid", to_id: "acme-uuid", relation: "works_at", notes: "VP Engineering since 2023" })',
        'await codemode.linkEntities({ from_id: "sarah-uuid", to_id: "project-uuid", relation: "involved_in" })',
      ],
      execute: async (args, env) => executeLinkEntities(args, env),
    },

    getRelations: {
      description:       entityDeclarations.find(d => d.name === 'getRelations')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'getRelations')!,
      category: 'memory',
      tags:     ['memory', 'entities', 'relations', 'edges', 'graph', 'connections', 'links', 'network'],
      returns:  '{ id, outgoing: [...], incoming: [...] }',
      examples: [
        'await codemode.getRelations({ id: "sarah-uuid" })',
        'await codemode.getRelations({ id: "acme-uuid", direction: "in", relation: "works_at" })',
      ],
      execute: async (args, env) => executeGetRelations(args, env),
    },

    defineSchema: {
      description:       entityDeclarations.find(d => d.name === 'defineSchema')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'defineSchema')!,
      category:  'memory',
      tags:      ['memory', 'entities', 'schema', 'type', 'define', 'template', 'fields'],
      returns:   '{ ok: boolean, type: string, display_name: string }',
      sideEffect: true,
      examples: [
        `await codemode.defineSchema({ type: "vendor", display_name: "Vendor", description: "A supplier or service provider", fields: JSON.stringify([{ key: "website", type: "string", label: "Website", indexed: false }, { key: "contract_end", type: "date", label: "Contract End", indexed: true }]) })`,
      ],
      execute: async (args, env) => executeDefineSchema(args, env),
    },

    getSchema: {
      description:       entityDeclarations.find(d => d.name === 'getSchema')!.description,
      geminiDeclaration: entityDeclarations.find(d => d.name === 'getSchema')!,
      category: 'memory',
      tags:     ['memory', 'entities', 'schema', 'type', 'fields', 'template', 'list'],
      returns:  '{ type, display_name, description, fields[] } | { types[] }',
      note:     'Always call this before createEntity to know what data fields to populate for a given type.',
      examples: [
        'await codemode.getSchema({ type: "contact" })',
        'await codemode.getSchema({})  // list all available types',
      ],
      execute: async (args, env) => executeGetSchema(args, env),
    },

    readMemory: {
      description:       dailyDeclarations.find(d => d.name === 'readMemory')!.description,
      geminiDeclaration: dailyDeclarations.find(d => d.name === 'readMemory')!,
      category: 'memory',
      tags:     ['memory', 'today', 'log', 'recall', 'context', 'daily', 'journal', 'read', 'what happened'],
      returns:  '{ date: string, path: string, exists: boolean, content: string | null }',
      execute: async (args) => executeReadMemory(args, env, ctx),
    },

    writeMemory: {
      description:       dailyDeclarations.find(d => d.name === 'writeMemory')!.description,
      geminiDeclaration: dailyDeclarations.find(d => d.name === 'writeMemory')!,
      category:  'memory',
      tags:      ['memory', 'log', 'record', 'remember', 'note', 'observe', 'follow-up', 'write'],
      returns:   '{ ok: boolean, date: string, path: string, entry: string }',
      sideEffect: true,
      execute: async (args) => executeWriteMemory(args, env, ctx),
    },

    searchChatHistory: {
      description:       historyDeclarations.find(d => d.name === 'searchChatHistory')!.description,
      geminiDeclaration: historyDeclarations.find(d => d.name === 'searchChatHistory')!,
      category: 'memory',
      tags:     ['memory', 'history', 'chat', 'past', 'search', 'previous', 'conversation', 'messages', 'recall'],
      returns:  '{ results: { role: string, content: string, timestamp: number }[] }',
      execute: async (args) => executeSearchChatHistory(env, ctx, String(args.query ?? '')),
    },

    getHistory: {
      description:       historyDeclarations.find(d => d.name === 'getHistory')!.description,
      geminiDeclaration: historyDeclarations.find(d => d.name === 'getHistory')!,
      category: 'memory',
      tags:     ['memory', 'history', 'recent', 'telegram', 'messages', 'context', 'autonomous', 'fetch'],
      returns:  '{ results: { role: string, content: string, timestamp: number }[] }',
      execute: async (args) => executeGetHistory(args, env),
    },

    // ── Research (including web fallback) ─────────────────────────────────────
    // Authoritative sources first. webSearch and fetchPage are the fallback
    // when no structured source covers the query.

    webSearch: {
      description:       webDeclarations.find(d => d.name === 'webSearch')!.description,
      geminiDeclaration: webDeclarations.find(d => d.name === 'webSearch')!,
      category: 'research',
      tags:     ['web', 'search', 'internet', 'current', 'news', 'online', 'external', 'lookup', 'fallback'],
      returns:  '{ results: { title: string, url: string, snippet: string }[] }',
      note:     'Fallback — use only when no authoritative tool covers the query. ' +
                'Prefer openAlex/arxiv for papers, wikipedia for facts, fred/worldBank for data, ' +
                'and math tools for computation.',
      execute: async (args) => {
        const results = await executeWebSearch(env, String(args.query ?? ''));
        return { results };
      },
    },

    fetchPage: {
      description:       webDeclarations.find(d => d.name === 'fetchPage')!.description,
      geminiDeclaration: webDeclarations.find(d => d.name === 'fetchPage')!,
      category: 'research',
      tags:     ['web', 'fetch', 'read', 'url', 'page', 'scrape', 'content', 'full-text', 'fallback'],
      returns:  '{ content: string } | { error: string }',
      note:     'Use after webSearch to read a full page, or to fetch a specific URL. ' +
                'Prefer structured research tools over webSearch + fetchPage when possible.',
      execute: async (args) => executeFetchPage(ctx, String(args.url ?? '')),
    },

    // ── Calendar ──────────────────────────────────────────────────────────────

    getCalendarEvents: {
      description:       calendarDeclarations.find(d => d.name === 'getCalendarEvents')!.description,
      geminiDeclaration: calendarDeclarations.find(d => d.name === 'getCalendarEvents')!,
      category: 'calendar',
      tags:     ['calendar', 'events', 'schedule', 'availability', 'meetings', 'appointments', 'busy'],
      returns:  '{ events: { summary: string, start: string, end: string, description?: string }[] }',
      execute: async (args) => executeGetCalendarEvents(env, ctx, {
        timeMin: args.timeMin ? String(args.timeMin) : undefined,
        timeMax: args.timeMax ? String(args.timeMax) : undefined,
      }),
    },

    createCalendarEvent: {
      description:       calendarDeclarations.find(d => d.name === 'createCalendarEvent')!.description,
      geminiDeclaration: calendarDeclarations.find(d => d.name === 'createCalendarEvent')!,
      category:  'calendar',
      tags:      ['calendar', 'create', 'book', 'event', 'meeting', 'schedule', 'add', 'appointment'],
      returns:   '{ success: boolean, eventId?: string } | { error: string }',
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

    deleteCalendarEvent: {
      description:       calendarDeclarations.find(d => d.name === 'deleteCalendarEvent')!.description,
      geminiDeclaration: calendarDeclarations.find(d => d.name === 'deleteCalendarEvent')!,
      category:  'calendar',
      tags:      ['calendar', 'delete', 'remove', 'cancel', 'event'],
      returns:   '{ success: boolean } | { error: string }',
      sideEffect: true,
      execute: async (args) => executeDeleteCalendarEvent(env, ctx, { eventId: String(args.eventId ?? '') }),
    },

    updateCalendarEvent: {
      description:       calendarDeclarations.find(d => d.name === 'updateCalendarEvent')!.description,
      geminiDeclaration: calendarDeclarations.find(d => d.name === 'updateCalendarEvent')!,
      category:  'calendar',
      tags:      ['calendar', 'update', 'edit', 'reschedule', 'change', 'event'],
      returns:   '{ success: boolean, eventId: string, updated: string[] } | { error: string }',
      sideEffect: true,
      execute: async (args) => executeUpdateCalendarEvent(env, ctx, {
        eventId:     String(args.eventId ?? ''),
        summary:     args.summary     ? String(args.summary)     : undefined,
        startTime:   args.startTime   ? String(args.startTime)   : undefined,
        endTime:     args.endTime     ? String(args.endTime)      : undefined,
        description: args.description ? String(args.description) : undefined,
      }),
    },

    // ── Async ─────────────────────────────────────────────────────────────────

    scheduleTimer: {
      description:       timerDeclarations.find(d => d.name === 'scheduleTimer')!.description,
      geminiDeclaration: timerDeclarations.find(d => d.name === 'scheduleTimer')!,
      category: 'async',
      tags:     ['async', 'timer', 'schedule', 'delay', 'later', 'future', 'remind', 'autonomous'],
      returns:  '{ ok: boolean, id: string, firesAt: string }',
      skill:    TIMER_SKILL,
      examples: [
        'await codemode.scheduleTimer({ minutes: 60, intent: "Check if the deployment finished and notify Andrew." })',
        'await codemode.scheduleTimer({ minutes: 1440, intent: "Follow up on EU-West outage mentioned earlier.", id: "eu-west-followup" })',
      ],
      execute: async (args) => executeScheduleTimer(args, env, ctx),
    },

    scheduleCode: {
      description:       timerDeclarations.find(d => d.name === 'scheduleCode')!.description,
      geminiDeclaration: timerDeclarations.find(d => d.name === 'scheduleCode')!,
      category: 'async',
      tags:     ['async', 'timer', 'schedule', 'code', 'deterministic', 'delay', 'later'],
      returns:  '{ ok: boolean, id: string, firesAt: string }',
      skill:    CODE_TIMER_SKILL,
      examples: [
        `await codemode.scheduleCode({ minutes: 30, label: "Send standup reminder", code: \`await codemode.sendTelegramMessage({ text: "Standup in 5 minutes!" })\` })`,
      ],
      execute: async (args) => executeScheduleCode(args, env, ctx),
    },

    cancelTimer: {
      description:       timerDeclarations.find(d => d.name === 'cancelTimer')!.description,
      geminiDeclaration: timerDeclarations.find(d => d.name === 'cancelTimer')!,
      category: 'async',
      tags:     ['async', 'timer', 'cancel', 'stop', 'remove'],
      returns:  '{ ok: boolean }',
      execute: async (args) => executeCancelTimer(args, env),
    },

    cancelCode: {
      description:       timerDeclarations.find(d => d.name === 'cancelCode')!.description,
      geminiDeclaration: timerDeclarations.find(d => d.name === 'cancelCode')!,
      category: 'async',
      tags:     ['async', 'code-timer', 'cancel', 'stop', 'remove'],
      returns:  '{ ok: boolean }',
      execute: async (args) => executeCancelCode(args, env),
    },

    registerCallback: {
      description:       callbackDeclarations.find(d => d.name === 'registerCallback')!.description,
      geminiDeclaration: callbackDeclarations.find(d => d.name === 'registerCallback')!,
      category: 'async',
      tags:     ['async', 'callback', 'trigger', 'event', 'telegram', 'reaction', 'message', 'watch'],
      returns:  '{ ok: boolean, id: string }',
      skill:    CALLBACK_SKILL,
      examples: [
        'await codemode.registerCallback({ triggerType: "telegram:message", pattern: "approved|lgtm", intent: "User approved the PR. Merge it.", id: "watch-approval" })',
        'await codemode.registerCallback({ triggerType: "telegram:reaction", emoji: "👍", messageId: 42, intent: "User thumbs-upped my proposal. Create a calendar event for the kickoff meeting tomorrow at 10am.", id: "thumbsup-42" })',
      ],
      execute: async (args) => executeRegisterCallback(args, env, ctx),
    },

    deleteCallback: {
      description:       callbackDeclarations.find(d => d.name === 'deleteCallback')!.description,
      geminiDeclaration: callbackDeclarations.find(d => d.name === 'deleteCallback')!,
      category: 'async',
      tags:     ['async', 'callback', 'delete', 'remove', 'cancel', 'unregister'],
      returns:  '{ ok: boolean, existed: boolean }',
      execute: async (args) => executeDeleteCallback(args, env),
    },

    listCallbacks: {
      description:       callbackDeclarations.find(d => d.name === 'listCallbacks')!.description,
      geminiDeclaration: callbackDeclarations.find(d => d.name === 'listCallbacks')!,
      category: 'async',
      tags:     ['async', 'callback', 'list', 'active', 'pending', 'registered', 'all'],
      returns:  '{ callbacks: { id, trigger, intent, persistent, depth, maxDepth }[] }',
      execute: async () => executeListCallbacks(env),
    },

    // ── Communication ─────────────────────────────────────────────────────────

    sendTelegramMessage: {
      description:       telegramDeclarations.find(d => d.name === 'sendTelegramMessage')!.description,
      geminiDeclaration: telegramDeclarations.find(d => d.name === 'sendTelegramMessage')!,
      category: 'communication',
      tags:     ['telegram', 'message', 'send', 'notify', 'proactive', 'dm', 'chat', 'reply'],
      returns:  '{ ok: boolean, messageId: number } | { error: string }',
      execute: async (args) => executeSendTelegramMessage(args, env, ctx),
    },

    // ── Math ──────────────────────────────────────────────────────────────────

    newtonMath: {
      description:       mathDeclarations.find(d => d.name === 'newtonMath')!.description,
      geminiDeclaration: mathDeclarations.find(d => d.name === 'newtonMath')!,
      category: 'math',
      tags:     [
        'math', 'symbolic', 'algebra', 'calculus', 'derivative', 'integral',
        'factor', 'simplify', 'zeroes', 'roots', 'tangent', 'area', 'trig',
        'trigonometry', 'sin', 'cos', 'tan', 'arcsin', 'arccos', 'arctan',
        'log', 'abs', 'newton', 'symbolic-math',
      ],
      returns:  '{ operation: string, expression: string, result: string } | { error: string }',
      note:     'Use for symbolic math: derivatives, integrals, factoring, zeroes, trig. ' +
                'Use wolframAlpha for anything Newton cannot handle (ODEs, series, eigenvalues). ' +
                'Use executeCode directly for pure numeric calculations.',
      skill:    NEWTON_SKILL,
      examples: [
        'await codemode.newtonMath({ operation: "derive", expression: "x^3+2x" })',
        'await codemode.newtonMath({ operation: "integrate", expression: "x^2+2x" })',
        'await codemode.newtonMath({ operation: "tangent", expression: "2|x^3" })',
        'await codemode.newtonMath({ operation: "area", expression: "2:4|x^3" })',
        'await codemode.newtonMath({ operation: "factor", expression: "x^2+2x" })',
      ],
      execute: async (args) => executeNewtonMath(args),
    },

    wolframAlpha: {
      description:       mathDeclarations.find(d => d.name === 'wolframAlpha')!.description,
      geminiDeclaration: mathDeclarations.find(d => d.name === 'wolframAlpha')!,
      category: 'math',
      tags:     [
        'math', 'advanced', 'wolfram', 'ode', 'differential-equation', 'series',
        'laplace', 'fourier', 'transform', 'number-theory', 'prime', 'matrix',
        'eigenvalue', 'statistics', 'distribution', 'unit-conversion', 'physics',
        'constants', 'science', 'natural-language', 'cas', 'computer-algebra',
      ],
      returns:  '{ query: string, pods: { title: string, text: string }[] } | { error: string }',
      note:     'Use when newtonMath cannot handle the problem — ODEs, series expansions, ' +
                'Laplace/Fourier transforms, eigenvalues, number theory. ' +
                'Never use webSearch as a fallback for math.',
      examples: [
        'await codemode.wolframAlpha({ query: "integrate sin(x^2) dx from 0 to 1" })',
        'await codemode.wolframAlpha({ query: "eigenvalues of [[1,2],[3,4]]" })',
        `await codemode.wolframAlpha({ query: "solve y'' + 3y' + 2y = e^x" })`,
        'await codemode.wolframAlpha({ query: "1000 USD in JPY" })',
      ],
      execute: async (args, env) => executeWolframAlpha(args, env),
    },

    // ── Research (authoritative sources) ──────────────────────────────────────

    openAlex: {
      description:       researchDeclarations.find(d => d.name === 'openAlex')!.description,
      geminiDeclaration: researchDeclarations.find(d => d.name === 'openAlex')!,
      category: 'research',
      tags:     [
        'research', 'academic', 'papers', 'literature', 'openalex',
        'authors', 'concepts', 'institutions', 'citations', 'doi',
        'pubmed', 'crossref', 'scholarly', 'science', 'publications',
      ],
      returns:  '{ total: number, results: { id, title, year, doi, open_access, url, authors, abstract }[] }',
      note:     'Prefer over webSearch for academic literature — structured metadata, no hallucination risk. ' +
                'Covers arXiv, PubMed, CrossRef. Use arxiv instead for preprint ID lookups or very fresh papers.',
      examples: [
        '// Pass 1 — fast scan, minimal tokens',
        'await codemode.openAlex({ query: "transformer neural networks", limit: 10, brief: true })',
        '// Pass 2 — full detail on the papers that look relevant',
        'await codemode.openAlex({ query: "transformer neural networks", filter: "publication_year:>2023", limit: 3, brief: false, abstractLength: 800 })',
        '// Author lookup',
        'await codemode.openAlex({ entity: "authors", query: "Yann LeCun", brief: true })',
        '// Recent open-access papers',
        'await codemode.openAlex({ query: "CRISPR", filter: "publication_year:>2023,open_access.is_oa:true", limit: 5, brief: true })',
      ],
      execute: async (args) => executeOpenAlex(args),
    },

    arxiv: {
      description:       researchDeclarations.find(d => d.name === 'arxiv')!.description,
      geminiDeclaration: researchDeclarations.find(d => d.name === 'arxiv')!,
      category: 'research',
      tags:     [
        'arxiv', 'preprint', 'paper-id', 'category', 'cs.LG', 'quant-ph',
        'math', 'physics', 'fresh', 'recent', 'abstract', 'pdf',
        'machine-learning', 'deep-learning', 'research',
      ],
      returns:  '{ total: number, results: { id, title, abstract, authors, published, url, pdf }[] }',
      note:     'Use for arXiv ID lookups (e.g. "2301.07041"), category browsing (e.g. "cs.LG"), ' +
                'or preprints too fresh for OpenAlex. Use openAlex for broad discovery queries.',
      examples: [
        '// Fetch a specific paper by ID',
        'await codemode.arxiv({ id: "2301.07041" })',
        '// Pass 1 — scan recent cs.LG papers, minimal tokens',
        'await codemode.arxiv({ category: "cs.LG", limit: 10, brief: true })',
        '// Pass 2 — full abstract on the ones that look relevant',
        'await codemode.arxiv({ query: "mixture of experts", category: "cs.LG", limit: 3, brief: false, abstractLength: 800 })',
      ],
      execute: async (args) => executeArxiv(args),
    },

    wikipedia: {
      description:       researchDeclarations.find(d => d.name === 'wikipedia')!.description,
      geminiDeclaration: researchDeclarations.find(d => d.name === 'wikipedia')!,
      category: 'research',
      tags:     [
        'wikipedia', 'wiki', 'encyclopedia', 'definition', 'summary', 'grounding',
        'history', 'biography', 'concept', 'factual', 'reference', 'article',
      ],
      returns:  '{ title, summary, url, also_matched: string[] }',
      note:     'Prefer over webSearch for grounding factual questions, definitions, and historical events ' +
                'that have a well-established Wikipedia article.',
      examples: [
        'await codemode.wikipedia({ query: "Fourier transform" })',
        'await codemode.wikipedia({ query: "Alan Turing" })',
      ],
      execute: async (args) => executeWikipedia(args),
    },

    fred: {
      description:       researchDeclarations.find(d => d.name === 'fred')!.description,
      geminiDeclaration: researchDeclarations.find(d => d.name === 'fred')!,
      category: 'research',
      tags:     [
        'fred', 'economics', 'macro', 'inflation', 'gdp', 'unemployment',
        'interest-rates', 'federal-reserve', 'cpi', 'time-series', 'data',
        'us-economy', 'monetary-policy', 'trade', 'industrial-production',
      ],
      returns:  '{ series_id, title, units, frequency, updated, observations: { date, value }[] }',
      note:     'Prefer over webSearch for any US macroeconomic time-series: CPI, GDP, unemployment, ' +
                'interest rates, trade, industrial production.',
      examples: [
        'await codemode.fred({ series_id: "CPIAUCSL", observation_start: "2020-01-01" })',
        'await codemode.fred({ series_id: "UNRATE", limit: 24 })',
        'await codemode.fred({ series_id: "FEDFUNDS", observation_start: "2022-01-01", observation_end: "2024-12-31" })',
      ],
      execute: async (args, env) => executeFred(args, env),
    },

    worldBank: {
      description:       researchDeclarations.find(d => d.name === 'worldBank')!.description,
      geminiDeclaration: researchDeclarations.find(d => d.name === 'worldBank')!,
      category: 'research',
      tags:     [
        'world-bank', 'global', 'development', 'gdp-per-capita', 'population',
        'poverty', 'literacy', 'co2', 'energy', 'country', 'international',
        'indicators', 'economics', 'statistics', 'climate',
      ],
      returns:  '{ indicator, indicator_name, total, results: { country, year, value }[] }',
      note:     'Prefer over webSearch for global development data — GDP per capita, population, ' +
                'CO2 emissions, literacy rates, poverty across countries.',
      examples: [
        'await codemode.worldBank({ indicator: "NY.GDP.PCAP.CD", country: "US", date_range: "2015:2023" })',
        'await codemode.worldBank({ indicator: "SP.POP.TOTL", country: "all", date_range: "2023" })',
        'await codemode.worldBank({ indicator: "EN.ATM.CO2E.PC", country: "CHN", date_range: "2010:2022" })',
      ],
      execute: async (args) => executeWorldBank(args),
    },

  };
}

export function getAllDeclarations(registry: Record<string, ToolDef>): Record<string, unknown>[] {
  return Object.values(registry).map((t) => t.geminiDeclaration);
}