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

import {
  webDeclarations,
  executeWebSearch,
  executeFetchPage,
} from './web';

import {
  calendarDeclarations,
  executeGetCalendarEvents,
  executeCreateCalendarEvent,
} from './calendar';

import { historyDeclarations, executeSearchChatHistory } from './history';

// ── ToolDef ───────────────────────────────────────────────────────────────────

/**
 * A single registered tool.
 *
 * `geminiDeclaration` — the function declaration passed to the Gemini API.
 * `execute`           — the host-side implementation, receives raw args from the model.
 * `sideEffect`        — true if this tool mutates data (vault writes, calendar creates).
 *                       The agent loop uses this to know when to emit syncRequired.
 */
export interface ToolDef {
  description: string;
  geminiDeclaration: Record<string, unknown>;
  execute: (args: Record<string, unknown>, env: Env, ctx: AgentContext) => Promise<unknown>;
  sideEffect?: boolean;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildToolRegistry(env: Env, ctx: AgentContext): Record<string, ToolDef> {
  return {

    // ── Vault ───────────────────────────────────────────────────────────────

    searchVault: {
      description: vaultDeclarations.find(d => d.name === 'searchVault')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'searchVault')!,
      execute: async (args) => {
        const results = await executeSearchVault(env, ctx, String(args.query ?? ''));
        return { results: results.map((r: SearchResult) => ({ filename: r.filename, score: r.score, excerpt: r.excerpt })) };
      },
    },

    listNotes: {
      description: vaultDeclarations.find(d => d.name === 'listNotes')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'listNotes')!,
      execute: async (args) => executeListNotes(env, ctx, args.folder ? String(args.folder) : undefined),
    },

    readNote: {
      description: vaultDeclarations.find(d => d.name === 'readNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'readNote')!,
      execute: async (args) => executeReadNote(env, ctx, String(args.path ?? '')),
    },

    createNote: {
      description: vaultDeclarations.find(d => d.name === 'createNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'createNote')!,
      sideEffect: true,
      execute: async (args) => executeCreateNote(env, ctx, String(args.path ?? ''), String(args.content ?? '')),
    },

    editNote: {
      description: vaultDeclarations.find(d => d.name === 'editNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'editNote')!,
      sideEffect: true,
      execute: async (args) => executeEditNote(env, ctx, String(args.path ?? ''), String(args.content ?? '')),
    },

    patchNote: {
      description: vaultDeclarations.find(d => d.name === 'patchNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'patchNote')!,
      sideEffect: true,
      execute: async (args) => executePatchNote(env, ctx, String(args.path ?? ''), String(args.find ?? ''), String(args.replace ?? '')),
    },

    deleteNote: {
      description: vaultDeclarations.find(d => d.name === 'deleteNote')!.description,
      geminiDeclaration: vaultDeclarations.find(d => d.name === 'deleteNote')!,
      sideEffect: true,
      execute: async (args) => executeDeleteNote(env, ctx, String(args.path ?? '')),
    },

    // ── Web ─────────────────────────────────────────────────────────────────

    webSearch: {
      description: webDeclarations.find(d => d.name === 'webSearch')!.description,
      geminiDeclaration: webDeclarations.find(d => d.name === 'webSearch')!,
      execute: async (args) => {
        const results = await executeWebSearch(ctx, String(args.query ?? ''));
        return { results };
      },
    },

    fetchPage: {
      description: webDeclarations.find(d => d.name === 'fetchPage')!.description,
      geminiDeclaration: webDeclarations.find(d => d.name === 'fetchPage')!,
      execute: async (args) => executeFetchPage(ctx, String(args.url ?? '')),
    },

    // ── Calendar ────────────────────────────────────────────────────────────

    getCalendarEvents: {
      description: calendarDeclarations.find(d => d.name === 'getCalendarEvents')!.description,
      geminiDeclaration: calendarDeclarations.find(d => d.name === 'getCalendarEvents')!,
      execute: async (args) => executeGetCalendarEvents(env, ctx, {
        timeMin: args.timeMin ? String(args.timeMin) : undefined,
        timeMax: args.timeMax ? String(args.timeMax) : undefined,
      }),
    },

    createCalendarEvent: {
      description: calendarDeclarations.find(d => d.name === 'createCalendarEvent')!.description,
      geminiDeclaration: calendarDeclarations.find(d => d.name === 'createCalendarEvent')!,
      sideEffect: true,
      execute: async (args) => {
        // Accept common aliases the model might use: title, name, subject → summary
        const summary = String(args.summary ?? args.title ?? args.name ?? args.subject ?? '').trim();
        if (!summary) {
          return {
            success: false,
            error: 'Missing event title. Please provide the field as "summary" (e.g. { summary: "Meeting with Bob", ... }).',
          };
        }
        return executeCreateCalendarEvent(env, ctx, {
          summary,
          startTime: String(args.startTime ?? ''),
          endTime: String(args.endTime ?? ''),
          description: args.description ? String(args.description) : undefined,
        });
      },
    },

    // ── History ─────────────────────────────────────────────────────────────

    searchChatHistory: {
      description: historyDeclarations.find(d => d.name === 'searchChatHistory')!.description,
      geminiDeclaration: historyDeclarations.find(d => d.name === 'searchChatHistory')!,
      execute: async (args) => executeSearchChatHistory(env, ctx, String(args.query ?? '')),
    },

  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flat array of all Gemini function declarations — used outside Code Mode. */
export function getAllDeclarations(registry: Record<string, ToolDef>): Record<string, unknown>[] {
  return Object.values(registry).map((t) => t.geminiDeclaration);
}