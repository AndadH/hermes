-- Vault file manifest — source of truth for multi-device sync
-- Last-write-wins resolution via updatedAt (client-supplied unix ms)
CREATE TABLE IF NOT EXISTS vaultFiles (
  path        TEXT    PRIMARY KEY,   -- e.g. "folder/Note Title.md"
  contentHash TEXT    NOT NULL,      -- SHA-256 hex of file content
  updatedAt   INTEGER NOT NULL,      -- unix ms of last modification
  size        INTEGER NOT NULL       -- bytes
);

CREATE INDEX IF NOT EXISTS idx_vaultFiles_updatedAt ON vaultFiles (updatedAt);

-- Tombstone table — records deletions so they propagate to all devices
-- even when the deleting device was offline at the time.
-- Resolution rule: if tombstone.deletedAt > vaultFiles.updatedAt → deletion wins.
-- Tombstones are pruned after 30 days (safe assumption: all devices sync within that window).
CREATE TABLE IF NOT EXISTS deletedFiles (
  path      TEXT    PRIMARY KEY,
  deletedAt INTEGER NOT NULL    -- unix ms when the file was deleted
);

CREATE INDEX IF NOT EXISTS idx_deletedFiles_deletedAt ON deletedFiles (deletedAt);