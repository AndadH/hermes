// src/types.ts

// ── Cloudflare environment ────────────────────────────────────────────────────

export interface Env {
  // Bindings
  DB:          D1Database;
  VAULT:       R2Bucket;
  AI:          Ai;
  CHAT_DO:     DurableObjectNamespace;
  TIMER_DO:    DurableObjectNamespace;
  CALLBACK_DO: DurableObjectNamespace;

  // Worker Loader binding
  LOADER: WorkerLoader;

  // Secrets
  GOOGLE_AI_KEY:            string;
  API_SECRET:               string;
  TELEGRAM_BOT_TOKEN:       string;
  TELEGRAM_ALLOWED_USER_ID: string;
  TELEGRAM_CHAT_ID:         string;   // fixed chat to send proactive messages
  TAVILY_API_KEY:           string;   // Tavily search API — free tier at app.tavily.com
  GOOGLE_CAL_CLIENT_EMAIL:  string;
  GOOGLE_CAL_PRIVATE_KEY:   string;
  GOOGLE_CALENDAR_ID:       string;

  // Optional vars
  ENVIRONMENT?: string;
}

// ── Agent context ─────────────────────────────────────────────────────────────

export interface AgentContext {
  messages: StoredMessage[];
  platform: 'websocket' | 'telegram';
  metadata: Record<string, unknown>;
}

// ── Recursion budget ──────────────────────────────────────────────────────────

export interface RecursionBudget {
  depth:    number;
  maxDepth: number;
  originTs: number;
}

// ── Context specs — declarative context injection for async turns ─────────────
//
// The agent specifies at scheduling time what context its future self will need.
// The autonomous runner resolves these before invoking the kernel.
//
// telegram — recent messages from the Telegram chat
// vault    — content of a specific note
// history  — FTS search across all chat history
// calendar — upcoming calendar events in a time range

export type ContextSpec =
  | { source: 'telegram'; limit?: number }
  | { source: 'vault';    path: string }
  | { source: 'history';  query: string; limit?: number }
  | { source: 'calendar'; timeMin?: string; timeMax?: string };

// ── Timer ─────────────────────────────────────────────────────────────────────

interface TimerStateBase {
  id:       string;
  minutes:  number;
  depth:    number;
  maxDepth: number;
  originTs: number;
  context?: ContextSpec[];  // what the agent needs when it wakes up
}

export type TimerState =
  | (TimerStateBase & { mode: 'intent'; intent: string })
  | (TimerStateBase & { mode: 'code';   code: string; label?: string });

// ── Callbacks ─────────────────────────────────────────────────────────────────

export type CallbackTrigger =
  | { type: 'telegram:message';  pattern: string }
  | { type: 'telegram:reaction'; emoji?: string; messageId?: number };

export interface CallbackEntry {
  id:         string;
  trigger:    CallbackTrigger;
  intent:     string;
  createdAt:  number;
  persistent: boolean;
  context?:   ContextSpec[];
  depth:      number;
  maxDepth:   number;
  originTs:   number;
}

// ── D1 row types ──────────────────────────────────────────────────────────────

export interface VaultFile {
  path:        string;
  contentHash: string;
  updatedAt:   number;
  size:        number;
}

// ── Sync API payloads ─────────────────────────────────────────────────────────

export interface SyncManifestEntry {
  path:        string;
  contentHash: string;
  updatedAt:   number;
  size:        number;
}

export interface ManifestRequest  { files: SyncManifestEntry[]; }
export interface ManifestResponse { toUpload: string[]; toDownload: VaultFile[]; }

export interface BatchDownloadRequest { paths: string[]; }

export interface DownloadedFile {
  path:        string;
  content:     string;
  contentHash: string;
  updatedAt:   number;
  size:        number;
}

export interface BatchDownloadResponse { files: DownloadedFile[]; }

export interface DeleteRequest {
  deletions: { path: string; deletedAt: number }[];
}

export interface Tombstone {
  path:      string;
  deletedAt: number;
}

// ── Agent / search types ──────────────────────────────────────────────────────

export interface SearchResult {
  filename: string;
  score:    number;
  link:     string;
  excerpt:  string;
}

// ── Durable Object storage ────────────────────────────────────────────────────

export interface StoredMessage {
  role:      'user' | 'assistant';
  content:   string;
  timestamp: number;
}

// ── WebSocket protocol ────────────────────────────────────────────────────────

export type WsIncoming =
  | { type: 'message'; content: string; activeNote?: string }
  | { type: 'stop' };

export type WsOutgoing =
  | { type: 'ready';        sessionId: string }
  | { type: 'token';        content: string }
  | { type: 'thinkingToken'; content: string }
  | { type: 'thinkingDone' }
  | { type: 'toolCall';     name: string; args: unknown; label: string; reasoning: string | null }
  | { type: 'toolResult';   name: string; args: unknown; results: SearchResult[] }
  | { type: 'syncRequired' }
  | { type: 'done' }
  | { type: 'error';        message: string };