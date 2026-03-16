import { DynamicWorkerExecutor, generateTypesFromJsonSchema, normalizeCode } from '@cloudflare/codemode';
import type { JsonSchemaToolDescriptors } from '@cloudflare/codemode';
import { buildToolRegistry } from '../tools/registry';
import { geminiCall, streamFinalAnswer, wsSend, toolLabel } from './gemini';
import type { Env, AgentContext, SearchResult } from '../types';

// ── KernelConfig ──────────────────────────────────────────────────────────────

export interface KernelConfig {
  /** Tool names always exposed as native Gemini declarations (no discovery needed). */
  hotTools: string[];
  /** Max tool-calling rounds before forcing the final answer stream. */
  maxRounds: number;
  /** Returns the full system prompt string for this platform + context. */
  buildPrompt: (ctx: AgentContext) => string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Gemini function_response.response must always be a Struct (plain object).
 * Never a string, number, or array at the top level — wrap if needed.
 */
function toStruct(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

// ── createKernel ──────────────────────────────────────────────────────────────

export function createKernel(config: KernelConfig, env: Env, ctx: AgentContext) {
  const registry = buildToolRegistry(env, ctx);
  const systemPrompt = config.buildPrompt(ctx);

  // ── JSON Schema type generation for executeCode description ───────────────
  const jsonSchemaTools: JsonSchemaToolDescriptors = Object.fromEntries(
    Object.entries(registry).map(([name, t]) => {
      const decl = t.geminiDeclaration as any;
      const normalizeSchema = (schema: any): any => {
        if (!schema || typeof schema !== 'object') return schema;
        const out: any = {};
        for (const [k, v] of Object.entries(schema)) {
          if (k === 'type' && typeof v === 'string') {
            out[k] = v.toLowerCase();
          } else if (typeof v === 'object') {
            out[k] = normalizeSchema(v);
          } else {
            out[k] = v;
          }
        }
        return out;
      };
      return [name, {
        description: t.description,
        inputSchema: normalizeSchema(decl.parameters ?? { type: 'object', properties: {} }),
      }];
    }),
  );
  const generatedTypes = generateTypesFromJsonSchema(jsonSchemaTools);

  // ── Sandbox executor ──────────────────────────────────────────────────────
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: 30_000,
  });

  // All tools available inside the sandbox via codemode.toolName(args)
  const toolFns: Record<string, (...args: unknown[]) => Promise<unknown>> = Object.fromEntries(
    Object.entries(registry).map(([name, t]) => [
      name,
      async (args: unknown) => t.execute(args as Record<string, unknown>, env, ctx),
    ]),
  );

  const specFns: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    spec: async () =>
      Object.fromEntries(
        Object.entries(registry).map(([name, t]) => [name, { description: t.description }]),
      ),
  };

  // ── Function declarations ─────────────────────────────────────────────────
  const hotDeclarations = config.hotTools
    .map((name) => registry[name]?.geminiDeclaration)
    .filter((d): d is Record<string, unknown> => d != null);

  const codeModeDeclarations = [
    {
      name: 'searchHermesAPI',
      description:
        'Discover available Hermes tools. Write a JS async arrow function. ' +
        'Call `await codemode.spec()` to get a map of tool names → descriptions, then filter and return what you need.',
      parameters: {
        type: 'OBJECT',
        properties: {
          code: {
            type: 'STRING',
            description: 'JavaScript async arrow function. Use `await codemode.spec()` to get the spec.',
          },
        },
        required: ['code'],
      },
    },
    {
      name: 'executeCode',
      description:
        'Execute JavaScript in a sandboxed Worker to chain multiple tool calls in one shot. ' +
        'Call tools via `await codemode.toolName(args)`. Returns { success, data, logs }.\n\n' +
        'Available tools and their TypeScript types:\n```ts\n' + generatedTypes + '\n```',
      parameters: {
        type: 'OBJECT',
        properties: {
          code: {
            type: 'STRING',
            description: 'JavaScript async arrow function. Call tools via `await codemode.toolName(args)`.',
          },
        },
        required: ['code'],
      },
    },
  ];

  const functionDeclarations = [...hotDeclarations, ...codeModeDeclarations];

  // The set of tool names the model is actually allowed to call directly.
  // Anything outside this is a hallucination — return a clear error.
  const declaredTools = new Set([
    ...config.hotTools,
    'searchHermesAPI',
    'executeCode',
  ]);

  // ── Dispatch ──────────────────────────────────────────────────────────────

  async function dispatch(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Reject hallucinated tool names not actually declared to the model
    if (!declaredTools.has(name)) {
      return {
        error: `Tool "${name}" is not available as a direct call. Use executeCode with codemode.${name}() instead.`,
      };
    }

    if (name === 'searchHermesAPI') {
      // normalizeCode handles top-level const/let, various function formats, markdown fences
      const safe = normalizeCode(String(args.code ?? ''));
      const { result, error, logs } = await executor.execute(safe, specFns);
      if (error) return { error: `Search failed: ${error}`, logs: logs ?? [] };
      return toStruct(result);
    }

    if (name === 'executeCode') {
      const safe = normalizeCode(String(args.code ?? ''));
      const { result, error, logs } = await executor.execute(safe, toolFns);
      if (error) return { error, logs: logs ?? [] };
      return { success: true, data: result ?? null, logs: logs ?? [] };
    }

    const tool = registry[name];
    if (!tool) return { error: `Unknown tool: "${name}"` };

    const result = await tool.execute(args, env, ctx);
    return toStruct(result);
  }

  // ── runLoop ───────────────────────────────────────────────────────────────

  async function runLoop(ws: WebSocket, isStopped: () => boolean): Promise<string> {
    const contents: unknown[] = ctx.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    for (let round = 0; round < config.maxRounds; round++) {
      if (isStopped()) { wsSend(ws, { type: 'done' }); return ''; }

      const data: any = await geminiCall(env, systemPrompt, contents, functionDeclarations);
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const fnParts = parts.filter((p: any) => p.functionCall != null);

      if (!fnParts.length) break;

      // Strip thought parts before adding to history (prevents truncated responses)
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
          console.error(`[kernel] Tool "${name}" threw:`, msg);
          resultData = { error: msg };
        }

        // Emit syncRequired for any successful vault write
        const tool = registry[name];
        if (tool?.sideEffect && resultData?.success) {
          wsSend(ws, { type: 'syncRequired' });
        }

        // Surface search results to the UI if present
        const rawResults = (resultData?.results ?? (resultData?.data as any)?.results) as any[] | undefined;
        const searchResults: SearchResult[] = rawResults?.map?.((r: any) => ({
          filename: r.filename ?? r.title ?? '',
          score: r.score ?? 1,
          link: r.link ?? r.url ?? '',
          excerpt: r.excerpt ?? r.snippet ?? '',
        })) ?? [];

        wsSend(ws, { type: 'toolResult', name, args, results: searchResults });

        // response must always be a Struct — guaranteed by dispatch return type
        functionResponses.push({ functionResponse: { name, response: resultData } });
      }

      if (functionResponses.length) {
        (contents as any[]).push({ role: 'user', parts: functionResponses });
      }
    }

    if (isStopped()) { wsSend(ws, { type: 'done' }); return ''; }

    const finalText = await streamFinalAnswer(env, systemPrompt, contents, ws, isStopped);
    wsSend(ws, { type: 'done' });
    return finalText;
  }

  return { runLoop };
}