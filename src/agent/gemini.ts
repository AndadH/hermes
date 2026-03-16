import type { Env, WsOutgoing } from '../types';

// ── Config ────────────────────────────────────────────────────────────────────

export const GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const MAX_ROUNDS = 8;

// ── WebSocket helper ──────────────────────────────────────────────────────────

export function wsSend(ws: WebSocket, payload: WsOutgoing): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Silently ignore closed socket errors
  }
}

// ── Tool label ────────────────────────────────────────────────────────────────

export function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'searchVault':         return `Searching vault for "${args?.query}"…`;
    case 'listNotes':           return args?.folder ? `Listing "${args.folder}"…` : 'Listing all notes…';
    case 'readNote':            return `Reading "${args?.path}"…`;
    case 'createNote':          return `Creating "${args?.path}"…`;
    case 'editNote':            return `Editing "${args?.path}"…`;
    case 'patchNote':           return `Patching "${args?.path}"…`;
    case 'deleteNote':          return `Deleting "${args?.path}"…`;
    case 'webSearch':           return `Searching web for "${args?.query}"…`;
    case 'fetchPage':           return `Reading ${args?.url}…`;
    case 'searchChatHistory':   return `Searching history for "${args?.query}"…`;
    case 'getCalendarEvents':   return 'Checking calendar…';
    case 'createCalendarEvent': return `Booking "${args?.summary}"…`;

    case 'searchHermesAPI': {
      // Extract the filter subject from the code if possible
      const code = String(args?.code ?? '');
      const match = code.match(/includes\(['"]([^'"]+)['"]\)|===\s*['"]([^'"]+)['"]/);
      const subject = match?.[1] ?? match?.[2];
      return subject ? `Discovering tools matching "${subject}"…` : 'Discovering tools…';
    }

    case 'executeCode': {
      // Parse out all codemode.toolName() calls from the generated code
      const code = String(args?.code ?? '');
      const calls = [...code.matchAll(/codemode\.(\w+)\s*\(/g)].map(m => m[1]);
      const unique = [...new Set(calls)];
      if (unique.length === 0) return 'Executing code…';
      if (unique.length === 1) return `Running ${unique[0]}…`;
      // e.g. "Running readNote + editNote…"
      const joined = unique.slice(0, 3).join(' + ') + (unique.length > 3 ? ` +${unique.length - 3} more` : '');
      return `Running ${joined}…`;
    }

    default: return `Using ${name}…`;
  }
}

// ── Non-streaming call (tool-calling rounds) ──────────────────────────────────

export async function geminiCall(
  env: Env,
  system: string,
  contents: unknown[],
  functionDeclarations: unknown[],
): Promise<unknown> {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: -1 },
    },
    tools: [{ functionDeclarations }],
    tool_config: { function_calling_config: { mode: 'AUTO' } },
  };

  const res = await fetch(
    `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${env.GOOGLE_AI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Streaming call (final answer + thinking tokens) ───────────────────────────

export async function streamFinalAnswer(
  env: Env,
  system: string,
  contents: unknown[],
  ws: WebSocket,
  isStopped: () => boolean,
): Promise<string> {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: -1 },
    },
  };

  const res = await fetch(
    `${GEMINI_BASE}/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${env.GOOGLE_AI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini stream error ${res.status}: ${err}`);
  }
  if (!res.body) throw new Error('No response body from Gemini stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let sseBuffer = '';
  let wasThinking = false;
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
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const parts: any[] = parsed?.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            const text: string = part.text ?? '';
            if (!text) continue;
            if (part.thought === true) {
              wasThinking = true;
              wsSend(ws, { type: 'thinkingToken', content: text });
            } else {
              if (wasThinking && !answerStarted) {
                answerStarted = true;
                wsSend(ws, { type: 'thinkingDone' });
              }
              accumulated += text;
              wsSend(ws, { type: 'token', content: text });
            }
          }
        } catch { /* malformed SSE chunk */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return accumulated;
}