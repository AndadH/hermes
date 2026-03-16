// ── Cloudflare environment ──────────────────────────────────────────────────

export interface Env {
  // Bindings
  DB: D1Database;
  VAULT: R2Bucket;
  AI: Ai;
  GOOGLE_AI_KEY: string;  // wrangler secret put GOOGLE_AI_KEY
  CHAT_DO: DurableObjectNamespace;

  // Secrets (set via `wrangler secret put`)
  API_SECRET: string;

  // Optional vars
  ENVIRONMENT?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_USER_ID: string;
  GOOGLE_CAL_CLIENT_EMAIL: string;
  GOOGLE_CAL_PRIVATE_KEY: string;
  GOOGLE_CALENDAR_ID: string;
}

// ── D1 row types ─────────────────────────────────────────────────────────────

export interface VaultFile {
  path: string;
  contentHash: string;
  updatedAt: number; // unix ms
  size: number;      // bytes
}

// ── Sync API payloads ─────────────────────────────────────────────────────────

export interface SyncManifestEntry {
  path: string;
  contentHash: string;
  updatedAt: number;
  size: number;
}

export interface ManifestRequest {
  files: SyncManifestEntry[];
}

export interface ManifestResponse {
  toUpload: string[];    // paths client must push
  toDownload: VaultFile[]; // files client must pull
}

export interface BatchDownloadRequest {
  paths: string[];
}

export interface DownloadedFile {
  path: string;
  content: string;
  contentHash: string;
  updatedAt: number;
  size: number;
}

export interface BatchDownloadResponse {
  files: DownloadedFile[];
}

export interface DeleteRequest {
  // paths to delete, each with the timestamp at which the client deleted it
  deletions: { path: string; deletedAt: number }[];
}

export interface Tombstone {
  path: string;
  deletedAt: number; // unix ms
}

// ── Agent / search types ──────────────────────────────────────────────────────

export interface SearchResult {
  filename: string;     // full filename incl. .md
  score: number;        // 0–1 relevance
  link: string;         // [[Note Name]] obsidian wikilink
  excerpt: string;      // first ~500 chars of matched content
}

// ── Durable Object storage ────────────────────────────────────────────────────

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number; // unix ms
}

// ── WebSocket protocol ────────────────────────────────────────────────────────

// Incoming (client → server)
export type WsIncoming =
  | { type: 'message'; content: string; activeNote?: string }
  | { type: 'stop' };

// Outgoing (server → client)
export type WsOutgoing =
  | { type: 'ready';         sessionId: string }
  | { type: 'thinkingToken'; content: string }   // streaming thought tokens
  | { type: 'thinkingDone' }                     // thinking phase complete, response starting
  | { type: 'token';         content: string }
  | { type: 'toolCall';      name: string; args: Record<string, unknown>; label: string; reasoning: string | null }
  | { type: 'toolResult';    name: string; args: Record<string, unknown>; results: SearchResult[] }
  | { type: 'syncRequired' }
  | { type: 'done' }
  | { type: 'error';         message: string };