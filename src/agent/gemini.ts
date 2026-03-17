// src/agent/gemini.ts
import type { Env, WsOutgoing } from '../types';

// ── Config ────────────────────────────────────────────────────────────────────

export const GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
export const MAX_ROUNDS   = 8;

// ── WebSocket helper ──────────────────────────────────────────────────────────

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
      // Pull the most meaningful filter keyword from the traversal code
      const code  = String(args?.code ?? '');
      const match = code.match(/includes\(['"]([^'"]+)['"]\)|===\s*['"]([^'"]+)['"]/);
      const tag   = match?.[1] ?? match?.[2];
      // Or fall back to a direct spec property access: spec.scheduleTimer
      const prop  = code.match(/spec\.(\w+)/)?.[1];
      const subject = tag ?? prop;
      return subject ? 'Discovering tools: ' + subject + '…' : 'Discovering tools…';
    }

    case 'executeCode': {
      // Parse all codemode.toolName() calls from the generated code
      const code   = String(args?.code ?? '');
      const calls  = [...code.matchAll(/codemode\.(\w+)\s*\(/g)]
        .map(m => m[1])
        .filter(n => n !== 'spec'); // exclude spec() from the label
      const unique = [...new Set(calls)];
      if (unique.length === 0) return 'Executing code…';
      if (unique.length === 1) return 'Running ' + unique[0] + '…';
      const joined = unique.slice(0, 3).join(' + ') + (unique.length > 3 ? ' +' + (unique.length - 3) + ' more' : '');
      return 'Running ' + joined + '…';
    }

    default: return 'Using ' + name + '…';
  }
}

// ── Non-streaming call (tool-calling rounds) ──────────────────────────────────

export async function geminiCall(
  env:                  Env,
  system:               string,
  contents:             unknown[],
  functionDeclarations: unknown[],
): Promise<unknown> {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: 2048,
      thinkingConfig:  { thinkingBudget: -1 },
    },
    tools:       [{ functionDeclarations }],
    tool_config: { function_calling_config: { mode: 'AUTO' } },
  };

  const res = await fetch(
    GEMINI_BASE + '/' + GEMINI_MODEL + ':generateContent?key=' + env.GOOGLE_AI_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (!res.ok) {
    throw new Error('Gemini API error ' + res.status + ': ' + await res.text());
  }
  return res.json();
}

// ── Streaming call (final answer + thinking tokens) ───────────────────────────

export async function streamFinalAnswer(
  env:                  Env,
  system:               string,
  contents:             unknown[],
  ws:                   WebSocket,
  isStopped:            () => boolean,
  functionDeclarations: unknown[] = [],  // passed in so recovery can retry with tools
): Promise<string> {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: 16384,
      thinkingConfig:  { thinkingBudget: -1 },
    },
  };

  const res = await fetch(
    GEMINI_BASE + '/' + GEMINI_MODEL + ':streamGenerateContent?alt=sse&key=' + env.GOOGLE_AI_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (!res.ok) throw new Error('Gemini stream error ' + res.status + ': ' + await res.text());
  if (!res.body) throw new Error('No response body from Gemini stream');

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated  = '';
  let sseBuffer    = '';
  let wasThinking  = false;
  let answerStarted = false;

  try {
    while (true) {
      if (isStopped()) break;
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let parsed: any;
        try { parsed = JSON.parse(jsonStr); } catch { continue; }

        // Detect Gemini-level errors in valid SSE (HTTP 200 but error body)
        const candidate    = parsed?.candidates?.[0];
        const finishReason = candidate?.finishReason;

        if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
          const blockReason = parsed?.promptFeedback?.blockReason;
          console.error('[streamFinalAnswer] finishReason=' + finishReason +
            (blockReason ? ' blockReason=' + blockReason : ''),
            JSON.stringify(candidate?.safetyRatings ?? {}));
        }

        const parts: any[] = candidate?.content?.parts ?? [];

        for (const part of parts) {
          if (part.thought) {
            if (!wasThinking) wasThinking = true;
            wsSend(ws, { type: 'thinkingToken', content: part.text ?? '' });
          } else if (typeof part.text === 'string') {
            if (wasThinking && !answerStarted) {
              wsSend(ws, { type: 'thinkingDone' });
              answerStarted = true;
            }
            accumulated += part.text;
            wsSend(ws, { type: 'token', content: part.text });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // If we got nothing at all, log for debugging
  if (!accumulated) {
    console.error('[streamFinalAnswer] empty response — contents length:', (contents as any[]).length);

    // UNEXPECTED_TOOL_CALL recovery: the model tried to call a tool in the
    // final answer round. Retry as a non-streaming call WITH function declarations
    // so it can actually execute what it wants.
    if (functionDeclarations.length > 0) {
      console.warn('[streamFinalAnswer] attempting recovery with functionDeclarations');
      try {
        const recovery: any = await geminiCall(env, system, contents, functionDeclarations);
        const text = recovery?.candidates?.[0]?.content?.parts
          ?.filter((p: any) => !p.thought && typeof p.text === 'string')
          ?.map((p: any) => p.text as string)
          ?.join('') ?? '';
        if (text) {
          wsSend(ws, { type: 'token', content: text });
          return text;
        }
      } catch (err) {
        console.error('[streamFinalAnswer] recovery failed:', err);
      }
    }
  }

  return accumulated;
}