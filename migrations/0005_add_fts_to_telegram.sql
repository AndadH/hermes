-- Create the FTS5 virtual table linked to our existing table
CREATE VIRTUAL TABLE telegram_history_fts USING fts5(
  content, 
  content='telegram_history', 
  content_rowid='id'
);

-- Rebuild the index natively to pull in any messages you've already sent
INSERT INTO telegram_history_fts(telegram_history_fts) VALUES('rebuild');

-- Single-line triggers to bypass Wrangler's parser bugs
CREATE TRIGGER telegram_history_ai AFTER INSERT ON telegram_history BEGIN INSERT INTO telegram_history_fts(rowid, content) VALUES (new.id, new.content); END;

CREATE TRIGGER telegram_history_ad AFTER DELETE ON telegram_history BEGIN INSERT INTO telegram_history_fts(telegram_history_fts, rowid, content) VALUES ('delete', old.id, old.content); END;

CREATE TRIGGER telegram_history_au AFTER UPDATE ON telegram_history BEGIN INSERT INTO telegram_history_fts(telegram_history_fts, rowid, content) VALUES ('delete', old.id, old.content); INSERT INTO telegram_history_fts(rowid, content) VALUES (new.id, new.content); END;