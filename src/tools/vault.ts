import type { Env, AgentContext, SearchResult } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content);
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizePath(path: string): string {
  return path.trim().endsWith('.md') ? path.trim() : `${path.trim()}.md`;
}

// ── Gemini function declarations ──────────────────────────────────────────────

export const vaultDeclarations = [
  {
    name: 'searchVault',
    description:
      'Semantic search over the Obsidian vault. Returns the most relevant notes with excerpts. Use before readNote or editNote when you need to find which note to work with.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'A specific, descriptive semantic search query.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'listNotes',
    description: 'List all notes in the vault, optionally filtered to a specific folder path.',
    parameters: {
      type: 'OBJECT',
      properties: {
        folder: { type: 'STRING', description: 'Optional folder path prefix to filter results.' },
      },
      required: [],
    },
  },
  {
    name: 'readNote',
    description: 'Read the full content of a specific note by its file path.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'The file path of the note (e.g. "folder/Note Title.md").' },
      },
      required: ['path'],
    },
  },
  {
    name: 'createNote',
    description: 'Create a new note. Fails if the note already exists — use editNote to update.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'The file path for the new note.' },
        content: { type: 'STRING', description: 'The full Markdown content of the note.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'editNote',
    description: 'Overwrite an existing note with new content. Always call readNote first to get the current content.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'The file path of the note to edit.' },
        content: { type: 'STRING', description: 'The complete new Markdown content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'patchNote',
    description: 'Make a targeted find-and-replace edit to a note. Use for small, surgical changes. Always call readNote first.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'The file path of the note to patch.' },
        find: { type: 'STRING', description: 'The exact text to find (must be unique in the note).' },
        replace: { type: 'STRING', description: 'The text to replace it with.' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'deleteNote',
    description: 'Permanently delete a note. Irreversible — only call when the user\'s intent is unambiguous.',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'The file path of the note to delete.' },
      },
      required: ['path'],
    },
  },
];

// ── Execute: searchVault ──────────────────────────────────────────────────────

export async function executeSearchVault(
  env: Env,
  _ctx: AgentContext,
  query: string,
): Promise<SearchResult[]> {
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
        score: Math.round((result.score ?? 0) * 100) / 100,
        link: `[[${noteName}]]`,
        excerpt,
      };
    });
  } catch (err) {
    console.error('[searchVault] AutoRAG error:', err);
    return [];
  }
}

// ── Execute: listNotes ────────────────────────────────────────────────────────

export async function executeListNotes(
  env: Env,
  _ctx: AgentContext,
  folder?: string,
): Promise<{ files: { path: string; size: number; updatedAt: number }[] }> {
  try {
    const prefix = folder ? (folder.endsWith('/') ? folder : `${folder}/`) : undefined;
    const listed = await env.VAULT.list({ prefix });
    const files = (listed.objects ?? []).map((obj) => ({
      path: obj.key,
      size: obj.size,
      updatedAt: obj.uploaded.getTime(),
    }));
    return { files };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[listNotes] Error:', msg);
    return { files: [] };
  }
}

// ── Execute: readNote ─────────────────────────────────────────────────────────

export async function executeReadNote(
  env: Env,
  _ctx: AgentContext,
  path: string,
): Promise<{ content?: string; error?: string }> {
  const filePath = normalizePath(path);
  try {
    const object = await env.VAULT.get(filePath);
    if (!object) return { error: `Note not found: "${filePath}"` };
    const content = await object.text();
    return { content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[readNote] Error reading "${filePath}":`, msg);
    return { error: msg };
  }
}

// ── Execute: createNote ───────────────────────────────────────────────────────

export async function executeCreateNote(
  env: Env,
  _ctx: AgentContext,
  path: string,
  content: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const filePath = normalizePath(path);
  try {
    const existing = await env.VAULT.head(filePath);
    if (existing) {
      return { success: false, path: filePath, error: `Note already exists at "${filePath}". Use editNote to update it.` };
    }
    const now = Date.now();
    const contentHash = await sha256Hex(content);
    const size = new TextEncoder().encode(content).length;
    await env.VAULT.put(filePath, content, {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: { contentHash, updatedAt: String(now) },
    });
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO vaultFiles (path, contentHash, updatedAt, size)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          contentHash = excluded.contentHash,
          updatedAt   = excluded.updatedAt,
          size        = excluded.size
      `).bind(filePath, contentHash, now, size),
      env.DB.prepare('DELETE FROM deletedFiles WHERE path = ?').bind(filePath),
    ]);
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[createNote] Error creating "${filePath}":`, msg);
    return { success: false, path: filePath, error: msg };
  }
}

// ── Execute: editNote ─────────────────────────────────────────────────────────

export async function executeEditNote(
  env: Env,
  _ctx: AgentContext,
  path: string,
  content: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const filePath = normalizePath(path);
  try {
    const existing = await env.VAULT.head(filePath);
    if (!existing) {
      return { success: false, path: filePath, error: `Note not found: "${filePath}". Use createNote to create it.` };
    }
    const now = Date.now();
    const contentHash = await sha256Hex(content);
    const size = new TextEncoder().encode(content).length;
    await env.VAULT.put(filePath, content, {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: { contentHash, updatedAt: String(now) },
    });
    await env.DB.prepare(`
      INSERT INTO vaultFiles (path, contentHash, updatedAt, size)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        contentHash = excluded.contentHash,
        updatedAt   = excluded.updatedAt,
        size        = excluded.size
    `).bind(filePath, contentHash, now, size).run();
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[editNote] Error editing "${filePath}":`, msg);
    return { success: false, path: filePath, error: msg };
  }
}

// ── Execute: patchNote ────────────────────────────────────────────────────────

export async function executePatchNote(
  env: Env,
  _ctx: AgentContext,
  path: string,
  find: string,
  replace: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const filePath = normalizePath(path);
  try {
    const object = await env.VAULT.get(filePath);
    if (!object) {
      return { success: false, path: filePath, error: `Note not found: "${filePath}".` };
    }
    const original = await object.text();
    if (!original.includes(find)) {
      return { success: false, path: filePath, error: `Text not found in note: "${find}"` };
    }
    const patched = original.replace(find, replace);
    const now = Date.now();
    const contentHash = await sha256Hex(patched);
    const size = new TextEncoder().encode(patched).length;
    await env.VAULT.put(filePath, patched, {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      customMetadata: { contentHash, updatedAt: String(now) },
    });
    await env.DB.prepare(`
      INSERT INTO vaultFiles (path, contentHash, updatedAt, size)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        contentHash = excluded.contentHash,
        updatedAt   = excluded.updatedAt,
        size        = excluded.size
    `).bind(filePath, contentHash, now, size).run();
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[patchNote] Error patching "${filePath}":`, msg);
    return { success: false, path: filePath, error: msg };
  }
}

// ── Execute: deleteNote ───────────────────────────────────────────────────────

export async function executeDeleteNote(
  env: Env,
  _ctx: AgentContext,
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
        env.DB.prepare('DELETE FROM vaultFiles WHERE path = ?').bind(filePath),
        env.DB.prepare(`
          INSERT INTO deletedFiles (path, deletedAt)
          VALUES (?, ?)
          ON CONFLICT(path) DO UPDATE SET deletedAt = excluded.deletedAt
        `).bind(filePath, deletedAt),
      ]),
    ]);
    return { success: true, path: filePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[deleteNote] Error deleting "${filePath}":`, msg);
    return { success: false, path: filePath, error: msg };
  }
}