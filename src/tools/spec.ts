// src/tools/spec.ts
//
// Builds the rich tool spec object passed into discoverTools and executeCode
// sandboxes via `await codemode.spec()`.
//
// Fields per tool:
//   description — one-line summary
//   category    — which neighborhood this tool belongs to
//   tags        — semantic vocabulary for filtering
//   args        — derived from geminiDeclaration.parameters
//   returns     — one-line return shape description
//   note?       — disambiguation hint, e.g. "prefer this over webSearch for X"
//   skill?      — usage guide, only on complex tools
//   examples?   — 1-2 codemode call examples
//
// Special key:
//   __index     — category map: { [category]: { description, tools: string[] } }
//                 Read this first in discoverTools to find the right neighborhood,
//                 then read only the tools in that bucket.

import type { ToolDef } from './registry';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolArgSpec {
  type:        string;
  required:    boolean;
  description: string;
}

export interface ToolSpecEntry {
  description: string;
  category:    string;
  tags:        string[];
  args:        Record<string, ToolArgSpec>;
  returns:     string;
  note?:       string;
  skill?:      string;
  examples?:   string[];
}

export interface CategoryEntry {
  description: string;
  tools:       string[];
}

export type HermesSpec = Record<string, ToolSpecEntry> & {
  __index: Record<string, CategoryEntry>;
};

// ── Category descriptions — shown in __index ──────────────────────────────────

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  vault:         'Read and write Obsidian notes and vault files',
  web:           'Live internet search and full page fetching',
  research:      'Authoritative structured data: academic papers, encyclopedias, economic data',
  math:          'Symbolic algebra, calculus, and advanced computer algebra system',
  calendar:      'Google Calendar read and write',
  async:         'Schedule future agent turns, code execution, and event-triggered callbacks',
  memory:        'Daily journal log — read and write persistent observations',
  communication: 'Send proactive Telegram messages',
  history:       'Search across past conversation history',
};

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildToolSpec(registry: Record<string, ToolDef>): HermesSpec {
  const spec: Record<string, ToolSpecEntry> = {};
  const categoryMap: Record<string, string[]> = {};

  for (const [name, tool] of Object.entries(registry)) {
    const decl       = tool.geminiDeclaration as any;
    const properties = decl?.parameters?.properties ?? {};
    const required   = new Set<string>(decl?.parameters?.required ?? []);

    const args: Record<string, ToolArgSpec> = {};
    for (const [argName, argDef] of Object.entries(properties as Record<string, any>)) {
      args[argName] = {
        type:        String(argDef.type ?? 'string').toLowerCase(),
        required:    required.has(argName),
        description: String(argDef.description ?? ''),
      };
    }

    const category = tool.category ?? 'misc';

    spec[name] = {
      description: tool.description,
      category,
      tags:        tool.tags ?? [],
      args,
      returns:     tool.returns ?? 'unknown',
      ...(tool.note     ? { note:     tool.note     } : {}),
      ...(tool.skill    ? { skill:    tool.skill    } : {}),
      ...(tool.examples ? { examples: tool.examples } : {}),
    };

    if (!categoryMap[category]) categoryMap[category] = [];
    categoryMap[category].push(name);
  }

  // Build __index — category map with descriptions and tool lists
  const index: Record<string, CategoryEntry> = {};
  for (const [cat, tools] of Object.entries(categoryMap)) {
    index[cat] = {
      description: CATEGORY_DESCRIPTIONS[cat] ?? cat,
      tools,
    };
  }

  return { ...spec, __index: index } as HermesSpec;
}