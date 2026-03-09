import type { Env, StoredMessage, SearchResult, WsOutgoing } from './types';

// ── Config ────────────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_ROUNDS   = 8;

// ── SHA-256 helper ────────────────────────────────────────────────────────────

async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Normalize path ────────────────────────────────────────────────────────────

function normalizePath(path: string): string {
  return path.trim().endsWith('.md') ? path.trim() : `${path.trim()}.md`;
}


// ── Web search result type ────────────────────────────────────────────────────

interface WebSearchResult {
  title:   string;
  url:     string;
  snippet: string;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const FUNCTION_DECLARATIONS = [
    {
    name: 'webSearch',
    description:
      'Search the web via DuckDuckGo for current information, news, facts, or anything not in the vault. Returns a list of results with titles, URLs, and snippets. Follow up with fetchPage on the most relevant URL to get the full content.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining why a web search is needed.',
        },
        query: {
          type: 'STRING',
          description: 'The search query to send to DuckDuckGo.',
        },
      },
      required: ['reasoning', 'query'],
    },
  },
  {
    name: 'fetchPage',
    description:
      'Fetch and read the full text content of a web page by URL. Use this after webSearch to read the full content of a promising result. Returns cleaned plain text, truncated to ~4000 characters.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining why this page is worth reading.',
        },
        url: {
          type: 'STRING',
          description: 'The full URL of the page to fetch.',
        },
      },
      required: ['reasoning', 'url'],
    },
  },
  {
    name: 'searchVault',
    description:
      'Semantic search over the Obsidian vault. Returns the most relevant notes with excerpts. Use before readNote or editNote when you need to find which note to work with.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining why searching is needed.',
        },
        query: {
          type: 'STRING',
          description: 'A specific, descriptive semantic search query.',
        },
      },
      required: ['reasoning', 'query'],
    },
  },
  {
    name: 'listNotes',
    description:
      'List all notes in a folder, or all notes in the entire vault if no folder is given. Returns file paths and last-modified timestamps. Use this to explore vault structure.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining why you need to list notes.',
        },
        folder: {
          type: 'STRING',
          description:
            'Optional. Vault-relative folder path, e.g. "Journal" or "Projects/Active". Omit to list the entire vault.',
        },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'readNote',
    description:
      'Read the full Markdown content of a single note by its exact vault-relative path. Always call this before editNote so you have the current content.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining why the full note content is needed.',
        },
        path: {
          type: 'STRING',
          description: 'Vault-relative path, e.g. "Journal/2025-03-08.md". The .md extension is optional.',
        },
      },
      required: ['reasoning', 'path'],
    },
  },
  {
    name: 'createNote',
    description:
      'Create a brand-new Markdown note. Fails if a note already exists at that path — use editNote to update an existing one.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining why this note is being created.',
        },
        path: {
          type: 'STRING',
          description: 'Vault-relative path for the new note, e.g. "Projects/My New Idea.md".',
        },
        content: {
          type: 'STRING',
          description: 'Full Markdown content of the new note.',
        },
      },
      required: ['reasoning', 'path', 'content'],
    },
  },
  {
    name: 'editNote',
    description:
      'Replace the entire content of an existing note. Always call readNote first. Fails if the note does not exist — use createNote instead.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining what change is being made and why.',
        },
        path: {
          type: 'STRING',
          description: 'Vault-relative path of the note to update.',
        },
        content: {
          type: 'STRING',
          description: 'The complete new Markdown content that will replace the existing note.',
        },
      },
      required: ['reasoning', 'path', 'content'],
    },
  },
  {
    name: 'appendToNote',
    description:
      'Append text to the end of an existing note without replacing any existing content. Good for journals, logs, and daily notes. Fails if the note does not exist.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining what is being appended and why.',
        },
        path: {
          type: 'STRING',
          description: 'Vault-relative path of the note to append to.',
        },
        content: {
          type: 'STRING',
          description: 'Markdown text to append. A blank line separator will be added automatically.',
        },
      },
      required: ['reasoning', 'path', 'content'],
    },
  },
  {
    name: 'deleteNote',
    description:
      'Permanently delete a note from the vault. Writes a tombstone so the deletion propagates to all synced devices. Irreversible — only call when intent is unambiguous.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining why this note should be deleted.',
        },
        path: {
          type: 'STRING',
          description: 'Vault-relative path of the note to delete.',
        },
      },
      required: ['reasoning', 'path'],
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
- NEVER output raw JSON or function call schemas

## Tool usage guidelines
- When asked to edit a note: always call readNote first, then editNote with the full updated content
- When asked to create a note: call createNote directly
- When asked to append to a note: call appendToNote directly — no need to readNote first
- Preserve all existing content unless the user explicitly asks you to remove something
- deleteNote is irreversible — only call it when the user's intent is unambiguous
- Use webSearch when the user asks about current events, recent news, external facts, or anything not in the vault
- After webSearch, call fetchPage on the most relevant result URL to get the full article or page content before answering
- Always cite your web sources with a Markdown link: [Page Title](https://url)
- **Do NOT add a Markdown heading (e.g. \`# Title\`) at the top of note content.** Obsidian uses the filename as the note title — adding a heading creates an ugly duplicate. Start note content directly with the body text or frontmatter.`;

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

// ── Tool: searchVault ─────────────────────────────────────────────────────────

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

// ── Tool: listNotes ───────────────────────────────────────────────────────────

interface NoteListEntry {
  path: string;
  updatedAt: number;
  size: number;
}

async function executeListNotes(
  env:    Env,
  folder: string | undefined,
): Promise<{ notes: NoteListEntry[]; count: number }> {
  try {
    const prefix = folder
      ? (folder.endsWith('/') ? folder : `${folder}/`)
      : undefined;

    const rows = prefix
      ? await env.DB
          .prepare('SELECT path, updatedAt, size FROM vaultFiles WHERE path LIKE ? ORDER BY path ASC')
          .bind(`${prefix}%`)
          .all<NoteListEntry>()
      : await env.DB
          .prepare('SELECT path, updatedAt, size FROM vaultFiles ORDER BY path ASC')
          .all<NoteListEntry>();

    const notes = rows.results ?? [];
    return { notes, count: notes.length };
  } catch (err) {
    console.error('[listNotes] D1 error:', err);
    return { notes: [], count: 0 };
  }
}

// ── Tool: readNote ────────────────────────────────────────────────────────────

async function executeReadNote(
  env:  Env,
  path: string,
): Promise<{ path: string; content: string } | { error: string }> {
  const filePath = normalizePath(path);
  try {
    const object = await env.VAULT.get(filePath);
    if (!object) return { error: `Note not found: "${filePath}"` };
    const content = await object.text();
    return { path: filePath, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[readNote] Error reading "${filePath}":`, msg);
    return { error: msg };
  }
}

// ── Tool: createNote ──────────────────────────────────────────────────────────

async function executeCreateNote(
  env:     Env,
  path:    string,
  content: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const filePath = normalizePath(path);
  try {
    const existing = await env.VAULT.head(filePath);
    if (existing) {
      return {
        success: false,
        path: filePath,
        error: `Note already exists at "${filePath}". Use editNote to update it.`,
      };
    }

    const now         = Date.now();
    const contentHash = await sha256Hex(content);
    const size        = new TextEncoder().encode(content).length;

    await env.VAULT.put(filePath, content, {
      httpMetadata:   { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: { contentHash, updatedAt: String(now) },
    });

    await env.DB.batch([
      env.DB
        .prepare(`
          INSERT INTO vaultFiles (path, contentHash, updatedAt, size)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            contentHash = excluded.contentHash,
            updatedAt   = excluded.updatedAt,
            size        = excluded.size
        `)
        .bind(filePath, contentHash, now, size),
      env.DB
        .prepare('DELETE FROM deletedFiles WHERE path = ?')
        .bind(filePath),
    ]);

    console.log(`[createNote] Created "${filePath}" (${size} bytes)`);
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[createNote] Error creating "${filePath}":`, msg);
    return { success: false, path: filePath, error: msg };
  }
}

// ── Tool: editNote ────────────────────────────────────────────────────────────

async function executeEditNote(
  env:     Env,
  path:    string,
  content: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const filePath = normalizePath(path);
  try {
    const existing = await env.VAULT.head(filePath);
    if (!existing) {
      return {
        success: false,
        path: filePath,
        error: `Note not found: "${filePath}". Use createNote to create it.`,
      };
    }

    const now         = Date.now();
    const contentHash = await sha256Hex(content);
    const size        = new TextEncoder().encode(content).length;

    await env.VAULT.put(filePath, content, {
      httpMetadata:   { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: { contentHash, updatedAt: String(now) },
    });

    await env.DB
      .prepare(`
        INSERT INTO vaultFiles (path, contentHash, updatedAt, size)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          contentHash = excluded.contentHash,
          updatedAt   = excluded.updatedAt,
          size        = excluded.size
      `)
      .bind(filePath, contentHash, now, size)
      .run();

    console.log(`[editNote] Updated "${filePath}" (${size} bytes)`);
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[editNote] Error editing "${filePath}":`, msg);
    return { success: false, path: filePath, error: msg };
  }
}

// ── Tool: appendToNote ────────────────────────────────────────────────────────

async function executeAppendToNote(
  env:     Env,
  path:    string,
  content: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const filePath = normalizePath(path);
  try {
    const object = await env.VAULT.get(filePath);
    if (!object) {
      return {
        success: false,
        path: filePath,
        error: `Note not found: "${filePath}". Use createNote to create it first.`,
      };
    }

    const existing   = await object.text();
    // Ensure a clean blank-line boundary between existing content and the new block
    const separator  = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    const newContent = existing + separator + content.trim() + '\n';

    const now         = Date.now();
    const contentHash = await sha256Hex(newContent);
    const size        = new TextEncoder().encode(newContent).length;

    await env.VAULT.put(filePath, newContent, {
      httpMetadata:   { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: { contentHash, updatedAt: String(now) },
    });

    await env.DB
      .prepare(`
        INSERT INTO vaultFiles (path, contentHash, updatedAt, size)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          contentHash = excluded.contentHash,
          updatedAt   = excluded.updatedAt,
          size        = excluded.size
      `)
      .bind(filePath, contentHash, now, size)
      .run();

    console.log(`[appendToNote] Appended to "${filePath}" (now ${size} bytes)`);
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[appendToNote] Error appending to "${filePath}":`, msg);
    return { success: false, path: filePath, error: msg };
  }
}

// ── Tool: deleteNote ──────────────────────────────────────────────────────────

async function executeDeleteNote(
  env:  Env,
  path: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const filePath = normalizePath(path);
  try {
    const existing = await env.VAULT.head(filePath);
    if (!existing) {
      return { success: false, path: filePath, error: `Note not found: "${filePath}".` };
    }

    const deletedAt = Date.now();

    await Promise.all([
      env.VAULT.delete(filePath),
      env.DB.batch([
        env.DB
          .prepare('DELETE FROM vaultFiles WHERE path = ?')
          .bind(filePath),
        env.DB
          .prepare(`
            INSERT INTO deletedFiles (path, deletedAt)
            VALUES (?, ?)
            ON CONFLICT(path) DO UPDATE SET deletedAt = excluded.deletedAt
          `)
          .bind(filePath, deletedAt),
      ]),
    ]);

    console.log(`[deleteNote] Deleted "${filePath}"`);
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[deleteNote] Error deleting "${filePath}":`, msg);
    return { success: false, path: filePath, error: msg };
  }
}

// ── Tool: webSearch ───────────────────────────────────────────────────────────

async function executeWebSearch(query: string): Promise<WebSearchResult[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      console.error(`[webSearch] DDG returned ${res.status}`);
      return [];
    }

    const html = await res.text();
    const results: WebSearchResult[] = [];

    // DDG HTML structure:
    //   <a class="result__a" href="...">Title</a>
    //   <a class="result__snippet">Snippet text</a>
    //
    // We extract using regex — no DOM available in Workers.
    const blockRe = /<div class="result[^"]*"[\s\S]*?(?=<div class="result[^"]*"|$)/g;
    const blocks  = html.match(blockRe) ?? [];

    for (const block of blocks) {
      if (results.length >= 8) break;

      // Extract URL from the uddg= redirect param (DDG wraps all links)
      const hrefMatch = block.match(/href="([^"]+)"/);
      if (!hrefMatch) continue;
      let url = hrefMatch[1];

      // Decode DDG redirect: //duckduckgo.com/l/?uddg=<encoded-url>
      const uddgMatch = url.match(/[?&]uddg=([^&"]+)/);
      if (uddgMatch) {
        try { url = decodeURIComponent(uddgMatch[1]); } catch { continue; }
      }
      // Skip DDG-internal links
      if (!url.startsWith('http')) continue;

      // Extract title (text inside result__a)
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch
        ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
        : url;

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        : '';

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    console.log(`[webSearch] "${query}" → ${results.length} results`);
    return results;
  } catch (err) {
    console.error('[webSearch] Error:', err);
    return [];
  }
}

// ── Tool: fetchPage ───────────────────────────────────────────────────────────

const FETCH_PAGE_MAX_CHARS = 4000;

async function executeFetchPage(url: string): Promise<{ url: string; content: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!res.ok) return { error: `HTTP ${res.status} fetching ${url}` };

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { error: `Unsupported content type: ${contentType}` };
    }

    const html = await res.text();

    // Strip scripts, styles, and tags; collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, ' ')
      .trim();

    const truncated = text.length > FETCH_PAGE_MAX_CHARS
      ? text.slice(0, FETCH_PAGE_MAX_CHARS) + '\n\n[… content truncated]'
      : text;

    console.log(`[fetchPage] ${url} → ${truncated.length} chars`);
    return { url, content: truncated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fetchPage] Error fetching "${url}":`, msg);
    return { error: msg };
  }
}

// ── WebSocket helper ──────────────────────────────────────────────────────────

function wsSend(ws: WebSocket, payload: WsOutgoing): void {
  ws.send(JSON.stringify(payload));
}

// ── Tool label helper ─────────────────────────────────────────────────────────

function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'searchVault':  return `Searching vault for "${args?.query}"…`;
    case 'listNotes':    return args?.folder ? `Listing notes in "${args.folder}"…` : 'Listing all notes…';
    case 'readNote':     return `Reading "${args?.path}"…`;
    case 'createNote':   return `Creating "${args?.path}"…`;
    case 'editNote':     return `Editing "${args?.path}"…`;
    case 'appendToNote': return `Appending to "${args?.path}"…`;
    case 'deleteNote':   return `Deleting "${args?.path}"…`;
    case 'webSearch':  return `Searching the web for "${args?.query}"…`;
    case 'fetchPage':  return `Reading ${args?.url}…`;
    default:             return `Using ${name}…`;
  }
}

// ── Gemini non-streaming call (tool-calling rounds) ───────────────────────────

async function geminiCall(env: Env, system: string, contents: any[]): Promise<any> {
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents,
    generationConfig: {
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: -1 },
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
      maxOutputTokens: 2048,
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

  const reader      = res.body.getReader();
  const decoder     = new TextDecoder();
  let accumulated   = '';
  let sseBuffer     = '';   // holds incomplete lines across read() boundaries
  let wasThinking   = false;
  let answerStarted = false;

  try {
    while (true) {
      if (isStopped()) break;
      const { done, value } = await reader.read();
      if (done) break;

      // Append to buffer and split on newlines, keeping the last (possibly
      // incomplete) line in the buffer for the next iteration.
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

  // ── Tool-calling loop ─────────────────────────────────────────────────────
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (isStopped()) { wsSend(ws, { type: 'done' }); return ''; }

    const data: any = await geminiCall(env, systemPrompt, contents);
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const fnParts = parts.filter((p: any) => p.functionCall != null);

    if (!fnParts.length) break;

    // Strip thought parts — Gemini returns {thought:true} tokens during extended thinking,
    // but including them in conversation history causes the next call to produce a truncated response.
    const historyParts = parts.filter((p: any) => !p.thought);
    contents.push({ role: 'model', parts: historyParts });

    const functionResponses: any[] = [];

    for (const part of fnParts) {
      if (isStopped()) break;

      const { name, args } = part.functionCall;
      const reasoning: string | null = args?.reasoning ?? null;

      wsSend(ws, { type: 'toolCall', name, args, label: toolLabel(name, args), reasoning });

      let resultData: any;

      if (name === 'searchVault') {
        const results = await executeSearchVault(env, args?.query ?? '');
        wsSend(ws, { type: 'toolResult', name, args, results });
        resultData = { results: results.map((r) => ({ filename: r.filename, score: r.score, excerpt: r.excerpt })) };

      } else if (name === 'listNotes') {
        resultData = await executeListNotes(env, args?.folder);
        wsSend(ws, { type: 'toolResult', name, args, results: [] });

      } else if (name === 'readNote') {
        resultData = await executeReadNote(env, args?.path ?? '');
        wsSend(ws, { type: 'toolResult', name, args, results: [] });

      } else if (name === 'createNote') {
        resultData = await executeCreateNote(env, args?.path ?? '', args?.content ?? '');
        wsSend(ws, { type: 'toolResult', name, args, results: [] });
        if (resultData.success) wsSend(ws, { type: 'syncRequired' });

      } else if (name === 'editNote') {
        resultData = await executeEditNote(env, args?.path ?? '', args?.content ?? '');
        wsSend(ws, { type: 'toolResult', name, args, results: [] });
        if (resultData.success) wsSend(ws, { type: 'syncRequired' });

      } else if (name === 'appendToNote') {
        resultData = await executeAppendToNote(env, args?.path ?? '', args?.content ?? '');
        wsSend(ws, { type: 'toolResult', name, args, results: [] });
        if (resultData.success) wsSend(ws, { type: 'syncRequired' });

      } else if (name === 'deleteNote') {
        resultData = await executeDeleteNote(env, args?.path ?? '');
        wsSend(ws, { type: 'toolResult', name, args, results: [] });
        if (resultData.success) wsSend(ws, { type: 'syncRequired' });

      }else if (name === 'webSearch') {
        const webResults = await executeWebSearch(args?.query ?? '');
        // Map to SearchResult shape so the client pill renders the URL list
        const results: SearchResult[] = webResults.map((r) => ({
          filename: r.title,
          score:    1,
          link:     r.url,
          excerpt:  r.snippet,
        }));
        wsSend(ws, { type: 'toolResult', name, args, results });
        resultData = { results: webResults };      
      } else if (name === 'fetchPage') {
        resultData = await executeFetchPage(args?.url ?? '');
        wsSend(ws, { type: 'toolResult', name, args, results: [] });
      } else {
        resultData = { error: `Unknown function: ${name}` };
      }

      functionResponses.push({ functionResponse: { name, response: resultData } });
    }

    if (functionResponses.length) {
      contents.push({ role: 'user', parts: functionResponses });
    }
  }

  if (isStopped()) { wsSend(ws, { type: 'done' }); return ''; }

  const finalText = await streamFinalAnswer(env, systemPrompt, contents, ws, isStopped);
  wsSend(ws, { type: 'done' });
  return finalText;
}