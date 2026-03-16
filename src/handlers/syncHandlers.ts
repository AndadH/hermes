import type { Context } from 'hono';
import type {
  Env,
  VaultFile,
  Tombstone,
  SyncManifestEntry,
  ManifestRequest,
  BatchDownloadRequest,
  BatchDownloadResponse,
  DownloadedFile,
  DeleteRequest,
} from '../types';

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── POST /sync/manifest ───────────────────────────────────────────────────────

export async function handleManifest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await c.req.json<ManifestRequest>();
  const clientFiles: SyncManifestEntry[] = body.files ?? [];

  const [serverRows, tombstoneRows] = await Promise.all([
    c.env.DB.prepare('SELECT path, contentHash, updatedAt, size FROM vaultFiles').all<VaultFile>(),
    c.env.DB.prepare('SELECT path, deletedAt FROM deletedFiles').all<Tombstone>(),
  ]);

  const serverMap = new Map<string, VaultFile>();
  for (const row of serverRows.results ?? []) {
    serverMap.set(row.path, row);
  }

  const tombstoneMap = new Map<string, number>();
  for (const t of tombstoneRows.results ?? []) {
    tombstoneMap.set(t.path, t.deletedAt);
  }

  const clientMap = new Map<string, SyncManifestEntry>();
  for (const f of clientFiles) {
    clientMap.set(f.path, f);
  }

  const toUpload: string[] = [];
  const toDownload: VaultFile[] = [];
  const toDeleteLocally: string[] = [];

  // Walk client files
  for (const clientFile of clientFiles) {
    const tombstoneDeletedAt = tombstoneMap.get(clientFile.path);
    const serverFile = serverMap.get(clientFile.path);

    if (tombstoneDeletedAt !== undefined) {
      if (clientFile.updatedAt > tombstoneDeletedAt) {
        toUpload.push(clientFile.path);
      } else {
        toDeleteLocally.push(clientFile.path);
      }
      continue;
    }

    if (!serverFile) {
      toUpload.push(clientFile.path);
    } else if (clientFile.contentHash !== serverFile.contentHash) {
      if (clientFile.updatedAt >= serverFile.updatedAt) {
        toUpload.push(clientFile.path);
      } else {
        toDownload.push(serverFile);
      }
    }
  }

  // Walk server-only files
  for (const [path, serverFile] of serverMap) {
    if (clientMap.has(path)) continue;
    if (tombstoneMap.has(path)) continue;
    toDownload.push(serverFile);
  }

  return c.json({ toUpload, toDownload, toDeleteLocally });
}

// ── POST /sync/upload ─────────────────────────────────────────────────────────

export async function handleUpload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const formData = await c.req.formData();
  const metadataRaw = formData.get('metadata') as string | null;

  if (!metadataRaw) {
    return c.json({ error: 'Missing "metadata" field in form data' }, 400);
  }

  const metadata: SyncManifestEntry[] = JSON.parse(metadataRaw);
  const uploaded: string[] = [];
  const failed: { path: string; reason: string }[] = [];

  for (const fileMeta of metadata) {
    try {
      const fileEntry = formData.get(fileMeta.path);
      if (!fileEntry) {
        failed.push({ path: fileMeta.path, reason: 'Missing file field in form' });
        continue;
      }

      const content = fileEntry instanceof File ? await fileEntry.text() : String(fileEntry);

      await c.env.VAULT.put(fileMeta.path, content, {
        httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
        customMetadata: {
          contentHash: fileMeta.contentHash,
          updatedAt: String(fileMeta.updatedAt),
        },
      });

      await c.env.DB.batch([
        c.env.DB.prepare(`
          INSERT INTO vaultFiles (path, contentHash, updatedAt, size)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            contentHash = excluded.contentHash,
            updatedAt   = excluded.updatedAt,
            size        = excluded.size
        `).bind(fileMeta.path, fileMeta.contentHash, fileMeta.updatedAt, fileMeta.size),
        c.env.DB.prepare('DELETE FROM deletedFiles WHERE path = ?').bind(fileMeta.path),
      ]);

      uploaded.push(fileMeta.path);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[upload] Failed for "${fileMeta.path}":`, reason);
      failed.push({ path: fileMeta.path, reason });
    }
  }

  return c.json({ uploaded, failed });
}

// ── POST /sync/batchDownload ──────────────────────────────────────────────────

export async function handleBatchDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { paths } = await c.req.json<BatchDownloadRequest>();

  if (!paths?.length) {
    return c.json<BatchDownloadResponse>({ files: [] });
  }

  const files: DownloadedFile[] = [];

  await Promise.all(
    paths.map(async (path) => {
      const [object, meta] = await Promise.all([
        c.env.VAULT.get(path),
        c.env.DB
          .prepare('SELECT contentHash, updatedAt, size FROM vaultFiles WHERE path = ?')
          .bind(path)
          .first<Pick<VaultFile, 'contentHash' | 'updatedAt' | 'size'>>(),
      ]);

      if (!object) {
        console.warn(`[batchDownload] Not found in R2: "${path}"`);
        return;
      }

      const content = await object.text();
      files.push({
        path,
        content,
        contentHash: meta?.contentHash ?? '',
        updatedAt: meta?.updatedAt ?? 0,
        size: meta?.size ?? content.length,
      });
    }),
  );

  return c.json<BatchDownloadResponse>({ files });
}

// ── POST /sync/delete ─────────────────────────────────────────────────────────

export async function handleDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { deletions } = await c.req.json<DeleteRequest>();

  if (!deletions?.length) {
    return c.json({ deleted: [] });
  }

  const deleted: string[] = [];

  await Promise.all(
    deletions.map(async ({ path, deletedAt }) => {
      await Promise.all([
        c.env.VAULT.delete(path),
        c.env.DB.batch([
          c.env.DB.prepare('DELETE FROM vaultFiles WHERE path = ?').bind(path),
          c.env.DB.prepare(`
            INSERT INTO deletedFiles (path, deletedAt)
            VALUES (?, ?)
            ON CONFLICT(path) DO UPDATE SET deletedAt = excluded.deletedAt
          `).bind(path, deletedAt),
        ]),
      ]);
      deleted.push(path);
    }),
  );

  // Prune stale tombstones — fire-and-forget
  c.executionCtx.waitUntil(
    c.env.DB
      .prepare('DELETE FROM deletedFiles WHERE deletedAt < ?')
      .bind(Date.now() - TOMBSTONE_TTL_MS)
      .run()
      .catch((err: any) => console.error('[delete] Tombstone prune failed:', err)),
  );

  return c.json({ deleted });
}