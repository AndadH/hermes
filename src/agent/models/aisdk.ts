

import { generateText, streamText, jsonSchema } from 'ai';
import { google }                                from '@ai-sdk/google';
import { anthropic }                             from '@ai-sdk/anthropic';
import { createWorkersAI }                       from 'workers-ai-provider';

import type { LanguageModel } from 'ai';
import type { Env, WsOutgoing } from '../../types';
import type {
  ModelClient,
  ModelResponse,
  KernelMessage,
  ToolDeclaration,
  ToolCall,
} from '../model';

// ── WebSocket helper ──────────────────────────────────────────────────────────
// Exported so kernel.ts can import without depending on any model adapter.

export function wsSend(ws: WebSocket, payload: WsOutgoing): void {
  try { ws.send(JSON.stringify(payload)); } catch { /* ignore closed socket */ }
}

// ── Tool label ────────────────────────────────────────────────────────────────

export function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'searchVault':         return 'Searching vault for "' + args?.query + '"…';
    case 'listNotes':           return args?.folder ? 'Listing "' + args.folder + '"…' : 'Listing all notes…';
    case 'readNote':            return 'Reading "' + args?.path + '"…';
    case 'createNote':          return 'Creating "' + args?.path + '"…';
    case 'editNote':            return 'Editing "' + args?.path + '"…';
    case 'patchNote':           return 'Patching "' + args?.path + '"…';
    case 'deleteNote':          return 'Deleting "' + args?.path + '"…';
    case 'webSearch':           return 'Searching web for "' + args?.query + '"…';
    case 'fetchPage':           return 'Reading ' + args?.url + '…';
    case 'searchChatHistory':   return 'Searching history for "' + args?.query + '"…';
    case 'getCalendarEvents':   return 'Checking calendar…';
    case 'createCalendarEvent': return 'Booking "' + args?.summary + '"…';

    case 'discoverTools': {
      const code  = String(args?.code ?? '');
      const match = code.match(/includes\(['"]([^'"]+)['"]\)|===\s*['"]([^'"]+)['"]/);
      const tag   = match?.[1] ?? match?.[2];
      const prop  = code.match(/spec\.(\w+)/)?.[1];
      const subject = tag ?? prop;
      return subject ? 'Discovering tools: ' + subject + '…' : 'Discovering tools…';
    }

    case 'executeCode': {
      const code   = String(args?.code ?? '');
      const calls  = [...code.matchAll(/codemode\.(\w+)\s*\(/g)]
        .map(m => m[1])
        .filter(n => n !== 'spec');
      const unique = [...new Set(calls)];
      if (unique.length === 0) return 'Executing code…';
      if (unique.length === 1) return 'Running ' + unique[0] + '…';
      const joined = unique.slice(0, 3).join(' + ') + (unique.length > 3 ? ' + ' + (unique.length - 3) + ' more' : '');
      return 'Running ' + joined + '…';
    }

    default: return 'Using ' + name + '…';
  }
}

// ── Model map ─────────────────────────────────────────────────────────────────

type ModelKey = 'kimi' | 'gemini' | 'claude' | 'claude-sonnet';

function resolveModel(key: string, env: Env): LanguageModel {
  switch (key as ModelKey) {
    case 'kimi': {
      const workersai = createWorkersAI({ binding: (env as any).AI });
      return workersai('@cf/moonshotai/kimi-k2.5');
    }
    case 'claude':
      return anthropic('claude-haiku-4-5-20251001');
    case 'claude-sonnet':
      return anthropic('claude-sonnet-4-6');
    case 'gemini':
    default:
      return google('gemini-2.5-flash');
  }
}

// ── Message converters ────────────────────────────────────────────────────────
// KernelMessage[] → AI SDK CoreMessage[]
//
// The AI SDK separates tool calls and tool results into different roles:
//   assistant turn: text + tool-call blocks
//   tool turn:      tool-result blocks (role='tool')
//
// Our KernelMessage format keeps them as separate messages already,
// so we just map roles and reshape the content blocks.

export function toSdkMessages(messages: KernelMessage[]): any[] {
  const out: any[] = [];

  for (const msg of messages) {
    const textParts   = msg.parts.filter(p => p.type === 'text' || p.type === 'thinking');
    const callParts   = msg.parts.filter(p => p.type === 'toolCall');
    const resultParts = msg.parts.filter(p => p.type === 'toolResult');

    if (resultParts.length > 0) {
      // Tool results always go in a 'tool' role message
      out.push({
        role:    'tool',
        content: resultParts.map(p => {
          if (p.type !== 'toolResult') return null;
          return {
            type:       'tool-result',
            toolCallId: p.id,
            toolName:   p.name,
            // Serialize to string — TypeBox rejects complex nested objects in output
            output:     typeof p.result === 'string' ? p.result : JSON.stringify(p.result),
          };
        }).filter(Boolean),
      });
    } else if (callParts.length > 0) {
      // Tool calls go in an assistant message with tool-call blocks
      out.push({
        role:    'assistant',
        content: [
          ...textParts.map(p => ({ type: 'text', text: (p as any).text })),
          ...callParts.map(p => {
            if (p.type !== 'toolCall') return null;
            return {
              type:       'tool-call',
              toolCallId: p.id,
              toolName:   p.name,
              input:      p.args,
            };
          }).filter(Boolean),
        ],
      });
    } else if (textParts.length > 0) {
      // Simple text message
      const text = textParts.map(p => (p as any).text).join('\n');
      out.push({ role: msg.role, content: text });
    }
  }

  return out;
}

// ToolDeclaration[] → AI SDK tools object
// The AI SDK tools parameter is { [name]: { description, parameters } }
// We use jsonSchema() to pass our existing JSON schema without Zod.
// Types are lowercased (OBJECT → object, STRING → string) for spec compliance.

function lowerTypes(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(lowerTypes);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : lowerTypes(v);
  }
  return out;
}

function toSdkTools(declarations: ToolDeclaration[]): Record<string, any> {
  const tools: Record<string, any> = {};
  for (const decl of declarations) {
    tools[decl.name] = {
      description: decl.description,
      parameters:  jsonSchema(lowerTypes(decl.parameters) as any),
    };
  }
  return tools;
}

// ── AiSdkClient ───────────────────────────────────────────────────────────────

export class AiSdkClient implements ModelClient {
  private model: LanguageModel;

  constructor(private env: Env, modelKey: string) {
    this.model = resolveModel(modelKey, env);
  }

  async call(
    system:     string,
    messages:   KernelMessage[],
    tools:      ToolDeclaration[],
    sdkHistory: unknown[],
  ): Promise<ModelResponse> {
    // Use accumulated SDK-format history if provided, otherwise convert from KernelMessage[]
    // sdkHistory is built up across rounds using result.response.messages to ensure
    // tool call IDs and message formats match exactly what the provider returned.
    const isFirstCall = sdkHistory.length === 0;
    const sdkMessages = isFirstCall ? toSdkMessages(messages) : sdkHistory as any[];

    // Seed sdkHistory with initial messages on first call so subsequent rounds
    // have the full conversation, not just the latest assistant turn
    if (isFirstCall) {
      for (const m of sdkMessages) (sdkHistory as any[]).push(m);
    }

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model:           this.model,
        system,
        messages:        sdkMessages,
        tools:           toSdkTools(tools),
        toolChoice:      'auto',
        maxOutputTokens: 4096,
      });
    } catch (err) {
      // Log the exact messages that failed validation so we can diagnose
      console.error('[AiSdkClient] generateText failed. sdkMessages:',
        JSON.stringify(sdkMessages, null, 2));
      throw err;
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      const calls: ToolCall[] = result.toolCalls.map(tc => {
        const raw = (tc as any).input ?? (tc as any).args ?? {};
        return {
          id:   tc.toolCallId,
          name: tc.toolName,
          // Dynamic tools may return args as a JSON string — parse defensively
          args: typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>,
        };
      });

      // Construct a clean CoreAssistantMessage manually rather than using
      // result.response.messages — ResponseMessage[] contains extra fields (id,
      // providerMetadata, etc.) that the AI SDK's own input schema rejects on
      // the next call, causing "messages do not match ModelMessage[] schema".
      const assistantContent: any[] = [];
      if (result.text?.trim()) {
        assistantContent.push({ type: 'text', text: result.text });
      }
      for (const call of calls) {
        assistantContent.push({
          type:       'tool-call',
          toolCallId: call.id,
          toolName:   call.name,
          input:      call.args,
        });
      }

      const sdkAssistantMessages: unknown[] = [{
        role:    'assistant',
        content: assistantContent,
      }];

      return { type: 'toolCalls', calls, sdkAssistantMessages };
    }

    return { type: 'done' };
  }

  async stream(
    system:     string,
    messages:   KernelMessage[],
    ws:         WebSocket,
    isStopped:  () => boolean,
    sdkHistory: unknown[] = [],
  ): Promise<string> {
    const sdkMessages = sdkHistory.length > 0
      ? sdkHistory as any[]
      : toSdkMessages(messages);

    // Seed sdkHistory if this is the first stream call
    if (sdkHistory.length === 0) {
      for (const m of sdkMessages) (sdkHistory as any[]).push(m);
    }

    const result = streamText({
      model:           this.model,
      system,
      messages:        sdkMessages,
      maxOutputTokens: 16384,
    });

    let accumulated   = '';
    let thinkingDone  = false;
    let hasThinking   = false;

    for await (const chunk of result.fullStream) {
      if (isStopped()) break;

      switch (chunk.type) {
        case 'reasoning-delta': {
          // Thinking/reasoning tokens — Claude extended thinking, Gemini thought parts
          hasThinking = true;
          wsSend(ws, { type: 'thinkingToken', content: (chunk as any).textDelta ?? '' });
          break;
        }
        case 'text-delta': {
          if (hasThinking && !thinkingDone) {
            wsSend(ws, { type: 'thinkingDone' });
            thinkingDone = true;
          }
          accumulated += chunk.text;
          wsSend(ws, { type: 'token', content: chunk.text });
          break;
        }
        case 'error': {
          console.error('[AiSdkClient.stream] stream error:', chunk.error);
          break;
        }
        // finish, tool-call, tool-result etc. ignored in final stream pass
      }
    }

    return accumulated;
  }
}