import type { Env, StoredMessage, SearchResult, WsOutgoing } from './types';

// ── Config ────────────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_ROUNDS   = 4;

// ── Tool definitions ──────────────────────────────────────────────────────────

const FUNCTION_DECLARATIONS = [
  {
    name: 'searchVault',
    description:
      'Semantic search over the personal Obsidian knowledge vault. Returns the most relevant notes with excerpts.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description:
            'Required. One sentence explaining why searching the vault is necessary — what context is missing from the conversation.',
        },
        query: {
          type: 'STRING',
          description: 'A specific, descriptive semantic search query.',
        },
      },
      required: ['reasoning', 'query'],
    },
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(activeNote: string): string {
  const base = `You are Hermes, a sharp and proactive executive assistant with deep access to a personal Obsidian knowledge vault.

## Response Style
- Use rich Markdown: headers, bullet points, **bold**, *italic*, \`code\`, blockquotes, and tables where useful
- When referencing vault notes always link them as [[Note Title]] (no .md extension)
- External URLs as standard Markdown links: [label](https://url)
- Be concise and direct — cut filler, preserve substance
- NEVER output raw JSON or function call schemas`;

  if (!activeNote?.trim()) return base;

  return `${base}

<active_note>
${activeNote.trim()}
</active_note>

The user is currently viewing the note above. Use it as your primary context.`;
}

// ── History → Gemini format ───────────────────────────────────────────────────

function historyToGemini(history: StoredMessage[]): any[] {
  return history.map((m) => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

// ── AutoRAG search ────────────────────────────────────────────────────────────

async function executeSearchVault(env: Env, query: string): Promise<SearchResult[]> {
  try {
    const response = await (env.AI as any).autorag('hermes-vault').search({
      query,
      max_num_results: 5,
      rewrite_query: true,
    });

    if (!response?.data || !Array.isArray(response.data)) return [];

    return response.data.map((result: any): SearchResult => {
      const rawFilename: string = result.filename ?? result.id ?? 'Unknown';
      const noteName = rawFilename.replace(/\.md$/i, '');
      const excerpt: string = (result.content ?? [])
        .map((c: any) => (c.text as string) ?? '')
        .join('\n')
        .slice(0, 400);

      return {
        filename: rawFilename,
        score:    Math.round((result.score ?? 0) * 100) / 100,
        link:     `[[${noteName}]]`,
        excerpt,
      };
    });
  } catch (err) {
    console.error('[searchVault] AutoRAG error:', err);
    return [];
  }
}

// ── WebSocket helper ──────────────────────────────────────────────────────────

function wsSend(ws: WebSocket, payload: WsOutgoing): void {
  ws.send(JSON.stringify(payload));
}

// ── Gemini non-streaming call (tool-calling rounds) ───────────────────────────

async function geminiCall(
  env:      Env,
  system:   string,
  contents: any[],
): Promise<any> {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: -1 }, // enables thought signatures for function calling
    },
    tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
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

// ── Gemini streaming call (final answer + thinking) ───────────────────────────
// Thinking tokens arrive as parts with `thought: true` before the answer parts.
// We stream thinking tokens as `thinkingToken` events, then send `thinkingDone`
// once the first real answer token arrives.

async function streamFinalAnswer(
  env:       Env,
  system:    string,
  contents:  any[],
  ws:        WebSocket,
  isStopped: () => boolean,
): Promise<string> {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: -1, includeThoughts: true }, // -1 = dynamic; includeThoughts sends thought parts in stream
    },
    // No tools in final stream — prevents tool-calling in the answer phase
  };

  const res = await fetch(
    `${GEMINI_BASE}/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${env.GOOGLE_AI_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini stream error ${res.status}: ${err}`);
  }

  const reader    = res.body!.getReader();
  const decoder   = new TextDecoder();
  let accumulated = '';
  let sseBuffer   = '';
  let wasThinking = false; // true once we've seen at least one thought token
  let answerStarted = false; // true once first real answer token sent

  try {
    while (true) {
      if (isStopped()) { await reader.cancel(); break; }

      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer   = lines.pop() ?? '';

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
              // Thinking token
              wasThinking = true;
              wsSend(ws, { type: 'thinkingToken', content: text });
            } else {
              // Real answer token — if we were thinking, signal the transition
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

// ── Main agent turn ───────────────────────────────────────────────────────────

export async function runAgentTurn(
  env:        Env,
  ws:         WebSocket,
  history:    StoredMessage[],
  activeNote: string,
  isStopped:  () => boolean,
): Promise<string> {

  const systemPrompt = buildSystemPrompt(activeNote);
  const contents: any[] = historyToGemini(history);

  // ── Tool-calling loop (non-streaming) ─────────────────────────────────────
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (isStopped()) { wsSend(ws, { type: 'done' }); return ''; }

    const data: any = await geminiCall(env, systemPrompt, contents);
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];

    const fnParts = parts.filter((p: any) => p.functionCall != null);

    // No function calls → exit loop, stream final answer
    if (!fnParts.length) break;

    // Record the model turn
    contents.push({ role: 'model', parts });

    // Execute each tool call
    const functionResponses: any[] = [];

    for (const part of fnParts) {
      if (isStopped()) break;

      const { name, args } = part.functionCall;
      const reasoning: string | null = args?.reasoning ?? null;

      wsSend(ws, {
        type:      'toolCall',
        name,
        args,
        label:     name === 'searchVault'
          ? `Searching vault for "${args?.query}"…`
          : `Using ${name}…`,
        reasoning,
      });

      let resultData: any;

      if (name === 'searchVault') {
        const results = await executeSearchVault(env, args?.query ?? '');
        wsSend(ws, { type: 'toolResult', name, results });
        resultData = {
          results: results.map((r) => ({
            filename: r.filename,
            score:    r.score,
            excerpt:  r.excerpt,
          })),
        };
      } else {
        resultData = { error: `Unknown function: ${name}` };
      }

      functionResponses.push({ functionResponse: { name, response: resultData } });
    }

    // All function responses bundled as a single user turn (Gemini requirement)
    if (functionResponses.length) {
      contents.push({ role: 'user', parts: functionResponses });
    }
  }

  if (isStopped()) { wsSend(ws, { type: 'done' }); return ''; }

  // ── Stream final answer with thinking ─────────────────────────────────────
  const finalText = await streamFinalAnswer(env, systemPrompt, contents, ws, isStopped);

  wsSend(ws, { type: 'done' });
  return finalText;
}