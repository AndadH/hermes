// src/tools/spec.ts
//
// Builds the rich tool spec object that is passed into both the discoverTools
// and executeCode sandboxes via `await codemode.spec()`.
//
// The spec is a plain serializable Record — the model traverses it with
// synchronous JS after a single `await codemode.spec()` call. No helper
// functions needed; the data is rich enough that code traversal is natural.
//
// Fields per tool:
//   description — one-line summary (from ToolDef)
//   tags        — semantic vocabulary for filtering (from ToolDef, manually curated)
//   args        — derived from geminiDeclaration.parameters, no manual duplication
//   returns     — one-line description of the return value shape (from ToolDef)
//   skill?      — usage guide, only on complex tools (from ToolDef)
//   examples?   — 1-2 codemode call examples, only where non-obvious (from ToolDef)

import type { ToolDef } from './registry';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolArgSpec {
  type:        string;
  required:    boolean;
  description: string;
}

export interface ToolSpecEntry {
  description: string;
  tags:        string[];
  args:        Record<string, ToolArgSpec>;
  returns:     string;
  skill?:      string;
  examples?:   string[];
}

export type HermesSpec = Record<string, ToolSpecEntry>;

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildToolSpec(registry: Record<string, ToolDef>): HermesSpec {
  const spec: HermesSpec = {};

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

    spec[name] = {
      description: tool.description,
      tags:        tool.tags ?? [],
      args,
      returns:     tool.returns ?? 'unknown',
      ...(tool.skill    ? { skill:    tool.skill    } : {}),
      ...(tool.examples ? { examples: tool.examples } : {}),
    };
  }

  return spec;
}