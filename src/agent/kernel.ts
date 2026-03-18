// src/agent/kernel.ts
import { DynamicWorkerExecutor, normalizeCode } from '@cloudflare/codemode';
import { buildToolRegistry } from '../tools/registry';
import { buildToolSpec } from '../tools/spec';
import { geminiCall, streamFinalAnswer, wsSend, toolLabel } from './gemini';
import type { Env, AgentContext, SearchResult } from '../types';

// ── KernelConfig ──────────────────────────────────────────────────────────────

export interface KernelConfig {
  hotTools:    string[];
  maxRounds:   number;
  buildPrompt: (ctx: AgentContext) => string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toStruct(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

// ── createKernel ──────────────────────────────────────────────────────────────

export function createKernel(config: KernelConfig, env: Env, ctx: AgentContext) {
  const registry = buildToolRegistry(env, ctx);
  const spec     = buildToolSpec(registry);

  // Auto-generate a hot-tools reference from registry data — no manual prompt maintenance.
  // Format: "- toolName(requiredArgs): returns — description"
  const hotToolsBlock = '## Hot tools (always available, call directly)\n' +
    config.hotTools.map(name => {
      const entry = spec[name];
      if (!entry) return '';
      const requiredArgs = Object.entries(entry.args)
        .filter(([_, a]) => a.required)
        .map(([k]) => k)
        .join(', ');
      return '- ' + name + '(' + requiredArgs + '): ' + entry.returns + ' — ' + entry.description;
    }).filter(Boolean).join('\n');

  const systemPrompt = config.buildPrompt(ctx) + '\n\n' + hotToolsBlock;

  // ── Sandbox executor ───────────────────────────────────────────────────────
  const executor = new DynamicWorkerExecutor({
    loader:  env.LOADER,
    timeout: 30_000,
  });

  // Tool callables for executeCode — every registered tool
  const toolFns: Record<string, (...args: unknown[]) => Promise<unknown>> = Object.fromEntries(
    Object.entries(registry).map(([name, t]) => [
      name,
      (args: unknown) => t.execute(args as Record<string, unknown>, env, ctx),
    ]),
  );

  // spec() is available in BOTH sandboxes — returns the full HermesSpec
  const specFn = async () => spec;

  // discoverTools sandbox: only spec, no tool execution
  const discoverFns: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    spec: specFn,
  };

  // executeCode sandbox: all tools + spec for inline reference
  const execFns: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    ...toolFns,
    spec: specFn,
  };

  // ── Function declarations ──────────────────────────────────────────────────

  const hotDeclarations = config.hotTools
    .map((name) => registry[name]?.geminiDeclaration)
    .filter((d): d is Record<string, unknown> => d != null);

  const codeModeDeclarations = [
    {
      name: 'discoverTools',
      description:
        'Explore available Hermes tools by writing JavaScript against the tool spec. ' +
        'Discovery rounds are free — they do not count against your action budget.\n\n' +

        'RECOMMENDED TWO-PASS PATTERN:\n' +
        '  Pass 1 — read the category index to find the right neighborhood:\n' +
        '    const spec = await codemode.spec();\n' +
        '    return spec.__index;\n' +
        '    // → { vault: { tools: [...] }, research: { tools: [...] }, math: { tools: [...] }, ... }\n\n' +
        '  Pass 2 — read only the tools in the relevant category:\n' +
        '    const spec = await codemode.spec();\n' +
        '    return spec.__index.research.tools.map(name => ({ name, ...spec[name] }));\n\n' +

        'Each tool entry has:\n' +
        '  description: string         — what the tool does\n' +
        '  category:    string         — which __index bucket it belongs to\n' +
        '  tags:        string[]       — semantic keywords\n' +
        '  args:        Record<string, { type, required, description }>\n' +
        '  returns:     string         — return value shape\n' +
        '  note?:       string         — when to prefer this tool over similar ones\n' +
        '  skill?:      string         — usage guide (present on complex tools)\n' +
        '  examples?:   string[]       — codemode call examples\n\n' +

        'Other useful traversals:\n' +
        '  // Check note fields to disambiguate between similar tools\n' +
        '  const spec = await codemode.spec();\n' +
        '  return spec.__index.research.tools.map(n => ({ n, note: spec[n].note }));\n\n' +
        '  // Get the full entry for a specific tool including its skill guide\n' +
        '  const spec = await codemode.spec();\n' +
        '  return spec.scheduleTimer;\n\n' +
        '  // Check exact arg shapes before calling\n' +
        '  const spec = await codemode.spec();\n' +
        '  return spec.newtonMath.args;',
      parameters: {
        type: 'OBJECT',
        properties: {
          code: {
            type: 'STRING',
            description:
              'JavaScript async arrow function body. ' +
              'Call `await codemode.spec()` to get the spec, then use synchronous JS to traverse it. ' +
              'Return whatever slice of the spec you need.',
          },
        },
        required: ['code'],
      },
    },
    {
      name: 'executeCode',
      description:
        'Execute JavaScript in a sandboxed Worker. ' +
        'Call any Hermes tool via `await codemode.toolName(args)`. ' +
        'The full tool spec is also available via `await codemode.spec()` for inline reference. ' +
        'Returns { success, data, logs }. ' +
        'Use discoverTools first if you need to find a tool or check its argument shape.',
      parameters: {
        type: 'OBJECT',
        properties: {
          code: {
            type: 'STRING',
            description:
              'JavaScript async arrow function body. ' +
              'Call tools via `await codemode.toolName(args)`. ' +
              'Optionally call `await codemode.spec()` to inspect tool shapes inline.',
          },
        },
        required: ['code'],
      },
    },
  ];

  const functionDeclarations = [...hotDeclarations, ...codeModeDeclarations];

  const declaredTools = new Set([
    ...config.hotTools,
    'discoverTools',
    'executeCode',
  ]);

  // ── Dispatch ───────────────────────────────────────────────────────────────

  async function dispatch(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!declaredTools.has(name)) {
      return {
        error: `"${name}" is not a direct tool. Use executeCode with codemode.${name}() instead.`,
      };
    }

    if (name === 'discoverTools') {
      const safe = normalizeCode(String(args.code ?? ''));
      const { result, error, logs } = await executor.execute(safe, discoverFns);
      if (error) return { error: `discoverTools failed: ${error}`, logs: logs ?? [] };
      return toStruct(result);
    }

    if (name === 'executeCode') {
      const code = String(args.code ?? '');
      const safe = normalizeCode(code);

      const { result, error, logs } = await executor.execute(safe, execFns);
      if (error) {
        // Extract codemode.toolName() calls and attach their spec entries for debugging
        const calledTools = [...code.matchAll(/codemode\.(\w+)\s*\(/g)]
          .map(m => m[1])
          .filter(n => n !== 'spec');
        const unique = [...new Set(calledTools)];
        const specHints: Record<string, unknown> = {};
        for (const toolName of unique) {
          if (spec[toolName]) {
            specHints[toolName] = {
              args:    spec[toolName].args,
              returns: spec[toolName].returns,
              ...(spec[toolName].skill ? { skill: spec[toolName].skill } : {}),
            };
          }
        }
        return {
          error,
          logs:  logs ?? [],
          hint:  'Use discoverTools to verify arg shapes, then retry with corrected code.',
          ...(unique.length > 0 ? { toolSpec: specHints } : {}),
        };
      }
      return { success: true, data: result ?? null, logs: logs ?? [] };
    }

    // Hot tool direct dispatch
    const tool = registry[name];
    if (!tool) return { error: `Unknown tool: "${name}"` };
    const result = await tool.execute(args, env, ctx);
    return toStruct(result);
  }

  // ── runLoop ────────────────────────────────────────────────────────────────

  async function runLoop(ws: WebSocket, isStopped: () => boolean): Promise<string> {
    const contents: unknown[] = ctx.messages.map((m) => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    // Discovery rounds are free — they don't burn the action budget.
    // Cap at FREE_DISCOVERY_ROUNDS to prevent runaway loops.
    // After the cap is exhausted, discovery rounds count as action rounds.
    const FREE_DISCOVERY_ROUNDS = 3;
    let freeDiscoveryUsed   = 0;
    let consecutiveDiscover = 0;
    let actionRound         = 0;

    while (actionRound < config.maxRounds) {
      if (isStopped()) { wsSend(ws, { type: 'done' }); return ''; }

      const data: any    = await geminiCall(env, systemPrompt, contents, functionDeclarations);
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const fnParts      = parts.filter((p: any) => p.functionCall != null);

      if (!fnParts.length) break;

      const historyParts = parts.filter((p: any) => !p.thought);
      (contents as any[]).push({ role: 'model', parts: historyParts });

      const functionResponses: unknown[] = [];

      for (const part of fnParts) {
        if (isStopped()) break;

        const { name, args } = part.functionCall;
        wsSend(ws, { type: 'toolCall', name, args, label: toolLabel(name, args), reasoning: null });

        let resultData: Record<string, unknown>;
        try {
          resultData = await dispatch(name, args ?? {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[kernel] Tool "' + name + '" threw:', msg);
          resultData = { error: msg };
        }

        const tool = registry[name];
        if (tool?.sideEffect && resultData?.success) {
          wsSend(ws, { type: 'syncRequired' });
        }

        const rawResults = (resultData?.results ?? (resultData?.data as any)?.results) as any[] | undefined;
        const searchResults: SearchResult[] = rawResults?.map?.((r: any) => ({
          filename: r.filename ?? r.title ?? '',
          score:    r.score ?? 1,
          link:     r.link ?? r.url ?? '',
          excerpt:  r.excerpt ?? r.snippet ?? '',
        })) ?? [];

        wsSend(ws, { type: 'toolResult', name, args, results: searchResults });
        functionResponses.push({ functionResponse: { name, response: resultData } });
      }

      if (functionResponses.length) {
        (contents as any[]).push({ role: 'user', parts: functionResponses });
      }

      // ── Round accounting ───────────────────────────────────────────────────
      // Pure-discovery rounds (every call was discoverTools) are free up to the
      // FREE_DISCOVERY_ROUNDS cap. After that they count as normal action rounds
      // so a stuck model cannot loop on discovery forever.

      const allDiscover = fnParts.every((p: any) => p.functionCall?.name === 'discoverTools');

      if (allDiscover) {
        consecutiveDiscover++;

        if (freeDiscoveryUsed < FREE_DISCOVERY_ROUNDS) {
          freeDiscoveryUsed++;
          // Do NOT increment actionRound — this was a free pass.
        } else {
          actionRound++;
        }

        // Three consecutive pure-discover rounds means the model is stuck — nudge it.
        if (consecutiveDiscover >= 3) {
          console.warn('[kernel] discoverTools loop detected — injecting nudge');
          (contents as any[]).push({
            role:  'user',
            parts: [{ text: '[SYSTEM] You have called discoverTools 3 times in a row. Call executeCode now or respond directly.' }],
          });
          consecutiveDiscover = 0;
        }
      } else {
        consecutiveDiscover = 0;
        actionRound++;
      }
    }

    if (isStopped()) { wsSend(ws, { type: 'done' }); return ''; }

    const finalText = await streamFinalAnswer(env, systemPrompt, contents, ws, isStopped, functionDeclarations);
    wsSend(ws, { type: 'done' });
    return finalText;
  }

  return { runLoop };
}