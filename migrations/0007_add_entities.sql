-- migrations/0007_add_entities.sql
--
-- Hermes Entity Store — hybrid structured/flexible knowledge base
--
-- Three tables:
--   entities        — core records (all types live here)
--   entity_schemas  — type templates the agent reads before creating
--   entity_relations — directed edges between entities
--
-- FTS5 virtual table indexes name, tags, notes, and the raw JSON data blob
-- so queries match across all fields regardless of entity type.
--
-- Wrangler D1 parser bug: all triggers must be on a single line.

-- ── Core entity table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entities (
  id         TEXT    PRIMARY KEY,           -- UUID
  type       TEXT    NOT NULL,              -- 'contact', 'project', 'book', etc.
  name       TEXT    NOT NULL,              -- display name, always required
  tags       TEXT    NOT NULL DEFAULT '',   -- comma-separated, FTS-indexed
  notes      TEXT    NOT NULL DEFAULT '',   -- append-only timestamped log
  data       TEXT    NOT NULL DEFAULT '{}', -- JSON blob for type-specific fields
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_type       ON entities (type);
CREATE INDEX IF NOT EXISTS idx_entities_name       ON entities (name);
CREATE INDEX IF NOT EXISTS idx_entities_updated_at ON entities (updated_at);

-- ── Schema registry ───────────────────────────────────────────────────────────
-- Stores field templates per entity type so the agent knows what to populate.
-- Not enforced at DB level — acts as a guide for the agent.

CREATE TABLE IF NOT EXISTS entity_schemas (
  type         TEXT    PRIMARY KEY,
  display_name TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  fields       TEXT    NOT NULL DEFAULT '[]', -- JSON array of field definitions
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ── Relationships (edges) ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entity_relations (
  id         TEXT    PRIMARY KEY,           -- UUID
  from_id    TEXT    NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id      TEXT    NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation   TEXT    NOT NULL,              -- e.g. 'works_at', 'introduced_by', 'involved_in'
  notes      TEXT    NOT NULL DEFAULT '',   -- optional context on the relationship
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relations_from_id ON entity_relations (from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to_id   ON entity_relations (to_id);
CREATE INDEX IF NOT EXISTS idx_relations_relation ON entity_relations (relation);

-- ── FTS5 virtual table ────────────────────────────────────────────────────────
-- Indexes name, tags, notes, and raw data JSON as text.
-- Searching for "acme" will match both name fields and JSON values like
-- {"organization":"Acme"} because FTS treats the blob as plain text.

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name,
  tags,
  notes,
  data,
  content='entities',
  content_rowid='rowid'
);

-- Rebuild index from any existing rows (safe to run on empty table)
INSERT INTO entities_fts(entities_fts) VALUES('rebuild');

-- Triggers to keep FTS in sync — must be single-line for Wrangler D1 parser
CREATE TRIGGER entities_ai AFTER INSERT ON entities BEGIN INSERT INTO entities_fts(rowid, name, tags, notes, data) VALUES (new.rowid, new.name, new.tags, new.notes, new.data); END;

CREATE TRIGGER entities_ad AFTER DELETE ON entities BEGIN INSERT INTO entities_fts(entities_fts, rowid, name, tags, notes, data) VALUES ('delete', old.rowid, old.name, old.tags, old.notes, old.data); END;

CREATE TRIGGER entities_au AFTER UPDATE ON entities BEGIN INSERT INTO entities_fts(entities_fts, rowid, name, tags, notes, data) VALUES ('delete', old.rowid, old.name, old.tags, old.notes, old.data); INSERT INTO entities_fts(rowid, name, tags, notes, data) VALUES (new.rowid, new.name, new.tags, new.notes, new.data); END;

-- ── Seed built-in schemas ─────────────────────────────────────────────────────

INSERT OR IGNORE INTO entity_schemas (type, display_name, description, fields, created_at, updated_at) VALUES (
  'contact',
  'Contact',
  'A person or individual the user knows or interacts with',
  '[
    {"key":"email",        "type":"string",  "label":"Email",        "indexed":true},
    {"key":"phone",        "type":"string",  "label":"Phone",        "indexed":false},
    {"key":"organization", "type":"string",  "label":"Organization", "indexed":true},
    {"key":"role",         "type":"string",  "label":"Role",         "indexed":false},
    {"key":"location",     "type":"string",  "label":"Location",     "indexed":false},
    {"key":"linkedin",     "type":"string",  "label":"LinkedIn",     "indexed":false},
    {"key":"twitter",      "type":"string",  "label":"Twitter/X",    "indexed":false},
    {"key":"last_contact", "type":"date",    "label":"Last Contact", "indexed":true},
    {"key":"relationship", "type":"string",  "label":"Relationship", "indexed":false}
  ]',
  unixepoch() * 1000,
  unixepoch() * 1000
);

INSERT OR IGNORE INTO entity_schemas (type, display_name, description, fields, created_at, updated_at) VALUES (
  'organization',
  'Organization',
  'A company, institution, or group',
  '[
    {"key":"website",   "type":"string", "label":"Website",  "indexed":false},
    {"key":"industry",  "type":"string", "label":"Industry", "indexed":true},
    {"key":"location",  "type":"string", "label":"Location", "indexed":false},
    {"key":"size",      "type":"string", "label":"Size",     "indexed":false},
    {"key":"founded",   "type":"string", "label":"Founded",  "indexed":false}
  ]',
  unixepoch() * 1000,
  unixepoch() * 1000
);

INSERT OR IGNORE INTO entity_schemas (type, display_name, description, fields, created_at, updated_at) VALUES (
  'project',
  'Project',
  'A project, initiative, or piece of work',
  '[
    {"key":"status",     "type":"string", "label":"Status",     "indexed":true},
    {"key":"deadline",   "type":"date",   "label":"Deadline",   "indexed":true},
    {"key":"priority",   "type":"string", "label":"Priority",   "indexed":false},
    {"key":"url",        "type":"string", "label":"URL",        "indexed":false},
    {"key":"budget",     "type":"string", "label":"Budget",     "indexed":false}
  ]',
  unixepoch() * 1000,
  unixepoch() * 1000
);

INSERT OR IGNORE INTO entity_schemas (type, display_name, description, fields, created_at, updated_at) VALUES (
  'book',
  'Book',
  'A book, article, or piece of written content',
  '[
    {"key":"author",    "type":"string", "label":"Author",     "indexed":true},
    {"key":"status",    "type":"string", "label":"Status",     "indexed":true},
    {"key":"isbn",      "type":"string", "label":"ISBN",       "indexed":false},
    {"key":"url",       "type":"string", "label":"URL",        "indexed":false},
    {"key":"rating",    "type":"number", "label":"Rating",     "indexed":false},
    {"key":"finished",  "type":"date",   "label":"Finished",   "indexed":false}
  ]',
  unixepoch() * 1000,
  unixepoch() * 1000
);