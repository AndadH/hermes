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
     name: 'patchNote',
     description:
       'Replace a specific substring within an existing note. Reads the note, finds the first occurrence of `find`, and replaces it with `replace`. Fails if `find` is not found or the note does not exist. Prefer this over editNote for targeted changes.',
     parameters: {
       type: 'OBJECT',
       properties: {
         reasoning: {
           type: 'STRING',
           description: 'One sentence explaining what is being changed and why.',
         },
         path: {
           type: 'STRING',
           description: 'Vault-relative path of the note to patch.',
         },
         find: {
           type: 'STRING',
           description: 'Exact string to locate in the note. Must match the current content character-for-character.',
         },
         replace: {
           type: 'STRING',
           description: 'String to substitute in place of `find`. Use an empty string to delete the matched text.',
         },
       },
       required: ['reasoning', 'path', 'find', 'replace'],
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
  {
    name: 'searchChatHistory',
    description:
      'Search previous Telegram chat history for context that is older than the current session. Use this if the user asks about something discussed days or weeks ago.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One sentence explaining why you need to search past chats.',
        },
        query: {
          type: 'STRING',
          description: 'A specific keyword or phrase to search for in the chat history.',
        },
      },
      required: ['reasoning', 'query'],
    },
  },
  {
    name: 'getCalendarEvents',
    description: 'Fetch upcoming events from the user\'s Google Calendar. Use this to check their schedule, find free time, or prepare them for the day.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'Why you are checking the calendar.',
        },
        timeMin: {
          type: 'STRING',
          description: 'ISO string of the start time (e.g., 2026-03-15T00:00:00Z). Defaults to now if omitted.',
        },
        timeMax: {
          type: 'STRING',
          description: 'ISO string of the end time (e.g., 2026-03-15T23:59:59Z).',
        },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'createCalendarEvent',
    description: 'Create a new event on the user\'s Google Calendar. Always confirm the details with the user before booking.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'Why this event is being created.',
        },
        summary: {
          type: 'STRING',
          description: 'The title of the event.',
        },
        startTime: {
          type: 'STRING',
          description: 'ISO string of the exact start time.',
        },
        endTime: {
          type: 'STRING',
          description: 'ISO string of the exact end time.',
        },
        description: {
          type: 'STRING',
          description: 'Optional. Details or context for the event.',
        },
      },
      required: ['reasoning', 'summary', 'startTime', 'endTime'],
    },
  }
];

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(activeNote: string): string {

  const now = new Date();
  const currentTime = now.toLocaleString('en-US', {
    timeZone: 'America/Denver',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
  const offsetStr = new Intl.DateTimeFormat('en-US', { 
    timeZone: 'America/Denver', 
    timeZoneName: 'longOffset' 
  }).format(now).split('GMT')[1] || 'Z';

  const base = `You are Hermes, a sharp and proactive executive assistant with deep access to a personal Obsidian knowledge vault.

CURRENT SYSTEM TIME: ${currentTime}
YOUR TIMEZONE OFFSET: ${offsetStr}

## Response Style
- Use rich Markdown: headers, bullet points, **bold**, *italic*, \`code\`, blockquotes, and tables where useful
- When referencing vault notes always link them as [[Note Title]] (no .md extension)
- External URLs as standard Markdown links: [label](https://url)
- Be concise and direct — cut filler, preserve substance
- NEVER output raw JSON or function call schemas

## Tool usage guidelines
- When you to need to edit a note: always call readNote first, then editNote with the full updated content
- When you need to to create a note: call createNote directly
- When you need to make a targeted edit to a note: call readNote first, then patchNote with the exact text to replace
- Preserve all existing content unless the user explicitly asks you to remove something
- deleteNote is irreversible — only call it when the user's intent is unambiguous
- Use webSearch when the user asks about current events, recent news, external facts, or anything not in the vault
- After webSearch, call fetchPage on the most relevant result URL to get the full article or page content before answering
- Always cite your web sources with a Markdown link: [Page Title](https://url)
- **Use searchChatHistory when the user references past conversations, previous chat topics, or things discussed days/weeks ago.**
- **Keep searchChatHistory queries simple (1-3 distinct keywords) for the best full-text search results.**
- **Use GetCalendarEvents to retrieve calendar events for admin and createCalendarEvent to create new events for admin**
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

// ── Tool: searchChatHistory ───────────────────────────────────────────────────

async function executeSearchChatHistory(env: Env, query: string): Promise<any> {
  try {
    // FTS5 MATCH supports advanced syntax (AND, OR, NOT, prefix*). 
    // We clean the query to prevent SQL syntax errors from weird LLM formatting.
    const cleanQuery = query.replace(/[^a-zA-Z0-9\s]/g, '').trim();
    if (!cleanQuery) return { message: "Search query was empty." };

    // Join the original table with the FTS search index
    const { results } = await env.DB.prepare(`
      SELECT 
        t.role, 
        t.content, 
        datetime(t.timestamp / 1000, 'unixepoch') as date
      FROM telegram_history t
      JOIN telegram_history_fts fts ON t.id = fts.rowid
      WHERE telegram_history_fts MATCH ?
      ORDER BY t.timestamp DESC 
      LIMIT 15
    `)
    // Adding '*' makes it a prefix search (e.g., "deploy*" matches "deploying")
    .bind(`"${cleanQuery}"*`)
    .all();
    
    if (!results || results.length === 0) {
      return { message: `No past conversations found matching "${cleanQuery}".` };
    }

    // Reverse so chronological order is maintained for the LLM
    return { 
      results: results.reverse().map((row: any) => `[${row.date}] ${row.role}: ${row.content}`) 
    };
  } catch (err) {
    console.error('[searchChatHistory] D1 error:', err);
    return { error: 'Failed to search chat history.' };
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

// ── Tool: patchNote ────────────────────────────────────────────────────────

async function executePatchNote(
    env: Env,
    path: string,
    find: string,
    replace: string,
): Promise<{ success: boolean; path: string; error?: string }> {
    const filePath = normalizePath(path);
    try {
        const object = await env.VAULT.get(filePath);
        if(!object) {
            return{
                success: false,
                path: filePath,
                error: `Note not found: "${filePath}". Use createNote to create it first.`
            }
        }

        const existing = await object.text();
        if(!existing.includes(find)) {
            return {
                success: false,
                path: filePath,
                error: `Patch failed: string to find was not found in "${filePath}". Read the note first to get the exact current content.`
            }
        }

        const newContent = existing.replace(find, replace);
        const now = Date.now();
        const contentHash = await sha256Hex(newContent);
        const size = new TextEncoder().encode(newContent).length;

        await env.VAULT.put(filePath, newContent, {
            httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
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
        console.log(`[patchNote] Patched "${filePath}" (now ${size} bytes)`);
        return { success: true, path: filePath };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[patchNote] Error reading "${filePath}":`, msg);
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

async function executeGetCalendarEvents(env: Env, args: any): Promise<any> {
  try {
    // Note: We'll need a helper function to generate the Google OAuth JWT token
    const token = await getGoogleAuthToken(env); 
    
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`);
    
    // Always expand recurring events into single instances
    url.searchParams.append('singleEvents', 'true');
    url.searchParams.append('orderBy', 'startTime');
    url.searchParams.append('maxResults', '15');

    // Apply the flexible parameters chosen by the LLM
    if (args.query) url.searchParams.append('q', args.query);
    if (args.timeMin) url.searchParams.append('timeMin', args.timeMin);
    if (args.timeMax) url.searchParams.append('timeMax', args.timeMax);
    
    // If it's a general request with no parameters, default to "upcoming events from now"
    if (!args.timeMin && !args.query) {
      url.searchParams.append('timeMin', new Date().toISOString());
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Google API error ${res.status}: ${errorText}`);
    }

    const data: any = await res.json();
    const events = data.items ?? [];

    if (events.length === 0) {
      return { message: 'No events found for this request.' };
    }

    // Strip down the massive Google API response to save LLM tokens
    return {
      events: events.map((e: any) => ({
        summary: e.summary,
        description: e.description,
        startTime: e.start?.dateTime || e.start?.date, // Handles both timed and all-day events
        endTime: e.end?.dateTime || e.end?.date,
        location: e.location,
        status: e.status
      }))
    };
  } catch (err) {
    console.error('[getCalendarEvents] Error:', err);
    return { error: 'Failed to fetch calendar events.' };
  }
}

// ── Tool: createCalendarEvent ─────────────────────────────────────────────────

async function executeCreateCalendarEvent(env: Env, args: any): Promise<any> {
  try {
    const token = await getGoogleAuthToken(env);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`;

    const body = {
      summary: args.summary,
      description: args.description || '',
      start: { dateTime: args.startTime },
      end: { dateTime: args.endTime },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Google API error ${res.status}: ${errorText}`);
    }

    const data: any = await res.json();
    
    return { 
      message: 'Event created successfully.',
      eventLink: data.htmlLink,
      eventId: data.id
    };
  } catch (err) {
    console.error('[createCalendarEvent] Error:', err);
    return { error: 'Failed to create calendar event.' };
  }
}

// ── Tool label helper ─────────────────────────────────────────────────────────

function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'searchVault':  return `Searching vault for "${args?.query}"…`;
    case 'listNotes':    return args?.folder ? `Listing notes in "${args.folder}"…` : 'Listing all notes…';
    case 'readNote':     return `Reading "${args?.path}"…`;
    case 'createNote':   return `Creating "${args?.path}"…`;
    case 'editNote':     return `Editing "${args?.path}"…`;
    case 'patchNote':    return `Patching "${args?.path}"…`;
    case 'deleteNote':   return `Deleting "${args?.path}"…`;
    case 'webSearch':  return `Searching the web for "${args?.query}"…`;
    case 'searchChatHistory': return `Searching past chats for "${args?.query}"...`;
    case 'getCalendarEvents':   return `Checking calendar...`;
    case 'createCalendarEvent': return `Booking "${args?.summary}"...`;
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

      } else if (name === 'patchNote') {
        resultData = await executePatchNote(env, args?.path ?? '', args?.find ?? '', args?.replace ?? '');
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
      } else if (name === 'searchChatHistory') {
        resultData = await executeSearchChatHistory(env, args?.query ?? '');
        wsSend(ws, { type: 'toolResult', name, args, results: [] });} 
      else if (name === 'getCalendarEvents') {
        resultData = await executeGetCalendarEvents(env, args ?? {});
        wsSend(ws, { type: 'toolResult', name, args, results: [] });
      }
      else if (name === 'createCalendarEvent') {
        resultData = await executeCreateCalendarEvent(env, args ?? {});
        wsSend(ws, { type: 'toolResult', name, args, results: [] });
      }
      else {
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

// ── Google Calendar Auth Helper ───────────────────────────────────────────────

async function getGoogleAuthToken(env: Env): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: env.GOOGLE_CAL_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  // Base64Url encoding helper
  const encodeBase64Url = (obj: any) => 
    btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  const encodedHeader = encodeBase64Url(header);
  const encodedClaimSet = encodeBase64Url(claimSet);
  const unsignedJwt = `${encodedHeader}.${encodedClaimSet}`;

  // 1. Clean the PEM string and convert to binary
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  // Replace actual literal newlines or escaped \n characters
  const pemContents = env.GOOGLE_CAL_PRIVATE_KEY
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .replace(/\\n/g, '')
    .replace(/\s/g, '');
    
  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  // 2. Import the key into Web Crypto
  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // 3. Sign the JWT
  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedJwt)
  );

  const signatureBase64Url = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  const signedJwt = `${unsignedJwt}.${signatureBase64Url}`;

  // 4. Exchange the signed JWT for a Google OAuth Access Token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Failed to get Google Token: ${err}`);
  }

  const tokenData: any = await tokenRes.json();
  return tokenData.access_token; // Valid for 1 hour
}