import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { Env } from './types';
import { authMiddleware, validateWsSecret } from './middleware';
import {
  handleManifest,
  handleUpload,
  handleBatchDownload,
  handleDelete,
} from './syncHandlers';
import { handleSearch } from './searchHandlers';
import { ChatDO } from './chatDO';

// Re-export the DO class so wrangler can register it
export { ChatDO };

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// CORS — Obsidian Electron origin is a local file context; allow all
app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  }),
);

// ── Public ────────────────────────────────────────────────────────────────────

app.get('/health', (c) =>
  c.json({ status: 'ok', timestamp: Date.now(), env: c.env.ENVIRONMENT ?? 'production' }),
);

// ── WebSocket chat ────────────────────────────────────────────────────────────
// Route: GET /ws/new          → creates a new ChatDO, streams back sessionId
//        GET /ws/:sessionId   → resumes existing session
//
// Auth: ?secret=<API_SECRET> (query param because WS clients can't set headers)
// The DO immediately sends { type: "ready", sessionId } on connect.
app.get('/ws/:sessionId', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  }

  // Authenticate before the upgrade completes
  const secret = c.req.query('secret');
  if (!validateWsSecret(secret, c.env.API_SECRET)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const sessionId = c.req.param('sessionId');
  let doId: DurableObjectId;

  if (sessionId === 'new') {
    doId = c.env.CHAT_DO.newUniqueId();
  } else {
    try {
      doId = c.env.CHAT_DO.idFromString(sessionId);
    } catch {
      return c.json({ error: 'Invalid session ID' }, 400);
    }
  }

  const stub = c.env.CHAT_DO.get(doId);
  return stub.fetch(c.req.raw);
});

// ── Protected HTTP routes ─────────────────────────────────────────────────────

app.use('/sync/*', authMiddleware);
app.use('/search', authMiddleware);

// Vault sync
app.post('/sync/manifest',      handleManifest);
app.post('/sync/upload',        handleUpload);
app.post('/sync/batchDownload', handleBatchDownload);
app.post('/sync/delete',        handleDelete);

// Semantic search (used by the Obsidian search panel, separate from chat agent)
app.post('/search', handleSearch);

// ── 404 fallthrough ───────────────────────────────────────────────────────────
app.all('*', (c) => c.json({ error: 'Not found' }, 404));

export default { fetch: app.fetch };