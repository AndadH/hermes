// src/tools/entities.ts
//
// Hermes Entity Store — hybrid structured/flexible knowledge base in D1.
//
// Three tables (see migrations/0006_add_entities.sql):
//   entities        — all entity types share one wide table
//   entity_schemas  — type templates the agent reads before creating
//   entity_relations — directed edges between entities
//
// Tool surface:
//   findEntities      — FTS search, slim results (discovery)
//   getEntity         — full record by ID
//   createEntity      — create with type + name + data
//   updateEntity      — patch data fields or top-level fields
//   appendEntityNote  — timestamped append to notes (never overwrites)
//   deleteEntity      — remove entity and cascade its relations
//   linkEntities      — create a named directed relationship between two entities
//   getRelations      — get all edges for an entity (in and/or out)
//   defineSchema      — create or update a type template
//   getSchema         — read schema for one type, or list all types

import type { Env } from '../types';

// ── Declarations ──────────────────────────────────────────────────────────────

export const entityDeclarations = [

  {
    name: 'findEntities',
    description:
      'Full-text search across all entities — matches name, tags, notes, and all JSON data fields. ' +
      'Returns slim results (id, type, name, tags, excerpt). ' +
      'Always use this first to check if an entity exists before creating. ' +
      'Follow up with getEntity to get the full record.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Search query. Matches across name, tags, notes, and all data fields.',
        },
        type: {
          type: 'STRING',
          description: 'Optional entity type filter: "contact", "project", "book", "organization", or any custom type.',
        },
        limit: {
          type: 'NUMBER',
          description: 'Max results. Default 10, max 50.',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'getEntity',
    description:
      'Fetch the full record for a single entity by ID. ' +
      'Returns all fields including complete notes history and data JSON. ' +
      'Use after findEntities to read the full detail.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: {
          type: 'STRING',
          description: 'Entity UUID from findEntities results.',
        },
      },
      required: ['id'],
    },
  },

  {
    name: 'createEntity',
    description:
      'Create a new entity. Always call findEntities first to avoid duplicates. ' +
      'Call getSchema to see expected data fields for the type before creating. ' +
      'The data field should be a JSON object matching the schema for the given type.',
    parameters: {
      type: 'OBJECT',
      properties: {
        type: {
          type: 'STRING',
          description: 'Entity type: "contact", "organization", "project", "book", or any custom type.',
        },
        name: {
          type: 'STRING',
          description: 'Display name — the primary identifier shown in search results.',
        },
        tags: {
          type: 'STRING',
          description: 'Optional comma-separated tags for filtering and search.',
        },
        data: {
          type: 'STRING',
          description:
            'JSON string of type-specific fields. ' +
            'Call getSchema first to see the expected shape. ' +
            'Example for contact: {"email":"sarah@acme.com","organization":"Acme","role":"VP Engineering"}',
        },
        note: {
          type: 'STRING',
          description: 'Optional initial note to add (timestamped automatically).',
        },
      },
      required: ['type', 'name'],
    },
  },

  {
    name: 'updateEntity',
    description:
      'Update an existing entity. Patches data fields and/or top-level fields (name, tags). ' +
      'Only fields you provide are changed — everything else is preserved. ' +
      'Never use this to add notes — use appendEntityNote instead.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: {
          type: 'STRING',
          description: 'Entity UUID to update.',
        },
        name: {
          type: 'STRING',
          description: 'New display name (optional).',
        },
        tags: {
          type: 'STRING',
          description: 'New comma-separated tags, replaces existing (optional).',
        },
        data: {
          type: 'STRING',
          description:
            'JSON object of data fields to patch. ' +
            'Merged into existing data — only keys you include are changed. ' +
            'Example: {"role":"CTO"} updates just the role field.',
        },
      },
      required: ['id'],
    },
  },

  {
    name: 'appendEntityNote',
    description:
      'Append a timestamped note to an entity\'s notes log. ' +
      'Never overwrites existing notes — always appends. ' +
      'Use this to grow context over time: observations, interactions, follow-ups. ' +
      'Keep notes concise (under 280 chars each).',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: {
          type: 'STRING',
          description: 'Entity UUID.',
        },
        note: {
          type: 'STRING',
          description: 'The note text. Will be prefixed with a timestamp automatically.',
        },
      },
      required: ['id', 'note'],
    },
  },

  {
    name: 'deleteEntity',
    description:
      'Permanently delete an entity and all its relationships. ' +
      'Irreversible — only use when explicitly requested.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: {
          type: 'STRING',
          description: 'Entity UUID to delete.',
        },
      },
      required: ['id'],
    },
  },

  {
    name: 'linkEntities',
    description:
      'Create a named directed relationship between two entities. ' +
      'Example relations: "works_at", "introduced_by", "involved_in", "manages", ' +
      '"reports_to", "knows", "invested_in", "competing_with". ' +
      'The relationship is directional: from_id → relation → to_id. ' +
      'Use getRelations to query existing links.',
    parameters: {
      type: 'OBJECT',
      properties: {
        from_id: {
          type: 'STRING',
          description: 'Source entity UUID.',
        },
        to_id: {
          type: 'STRING',
          description: 'Target entity UUID.',
        },
        relation: {
          type: 'STRING',
          description:
            'Relationship label — use snake_case. ' +
            'Examples: "works_at", "introduced_by", "involved_in", "manages", "knows", "invested_in".',
        },
        notes: {
          type: 'STRING',
          description: 'Optional context about this specific relationship.',
        },
      },
      required: ['from_id', 'to_id', 'relation'],
    },
  },

  {
    name: 'getRelations',
    description:
      'Get all relationships for an entity. ' +
      'Returns both outgoing (this entity → others) and incoming (others → this entity) edges, ' +
      'with the connected entity\'s name and type included.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: {
          type: 'STRING',
          description: 'Entity UUID to get relationships for.',
        },
        direction: {
          type: 'STRING',
          description: '"out" = outgoing only, "in" = incoming only, "both" (default) = all.',
        },
        relation: {
          type: 'STRING',
          description: 'Optional filter by relation label, e.g. "works_at".',
        },
      },
      required: ['id'],
    },
  },

  {
    name: 'defineSchema',
    description:
      'Create or update a schema template for an entity type. ' +
      'The schema tells the agent what fields to populate when creating entities of this type. ' +
      'Fields are soft guidance — not enforced at the DB level.',
    parameters: {
      type: 'OBJECT',
      properties: {
        type: {
          type: 'STRING',
          description: 'Entity type key, e.g. "vendor", "deal", "event".',
        },
        display_name: {
          type: 'STRING',
          description: 'Human-readable label for this type.',
        },
        description: {
          type: 'STRING',
          description: 'What this entity type represents.',
        },
        fields: {
          type: 'STRING',
          description:
            'JSON array of field definitions. Each field: ' +
            '{"key":"field_name","type":"string|number|date|boolean","label":"Display Label","indexed":true|false}',
        },
      },
      required: ['type', 'display_name', 'fields'],
    },
  },

  {
    name: 'getSchema',
    description:
      'Read the schema template for a specific entity type, or list all available types. ' +
      'Always call this before createEntity to know what data fields to populate.',
    parameters: {
      type: 'OBJECT',
      properties: {
        type: {
          type: 'STRING',
          description: 'Entity type to fetch. Omit to list all available types.',
        },
      },
      required: [],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

function timestamp(): string {
  return new Date().toLocaleString('en-US', {
    timeZone:  'America/Denver',
    month:     'short',
    day:       '2-digit',
    year:      'numeric',
    hour:      '2-digit',
    minute:    '2-digit',
    hour12:    false,
  });
}

function safeJson(value: unknown, fallback: string = '{}'): string {
  if (typeof value === 'string') {
    try { JSON.parse(value); return value; } catch {}
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return fallback;
}

// ── Executors ─────────────────────────────────────────────────────────────────

export async function executeFindEntities(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const query = String(args.query ?? '').trim();
  const type  = String(args.type  ?? '').trim();
  const limit = Math.min(Number(args.limit ?? 10), 50);

  if (!query) return { error: 'query is required' };

  // FTS search — returns rowid which we join back to entities for type filtering
  let sql: string;
  let binds: unknown[];

  if (type) {
    sql = `
      SELECT e.id, e.type, e.name, e.tags, e.updated_at,
             snippet(entities_fts, 2, '[', ']', '…', 12) AS excerpt
      FROM entities_fts
      JOIN entities e ON entities_fts.rowid = e.rowid
      WHERE entities_fts MATCH ?
        AND e.type = ?
      ORDER BY rank
      LIMIT ?
    `;
    binds = [query, type, limit];
  } else {
    sql = `
      SELECT e.id, e.type, e.name, e.tags, e.updated_at,
             snippet(entities_fts, 2, '[', ']', '…', 12) AS excerpt
      FROM entities_fts
      JOIN entities e ON entities_fts.rowid = e.rowid
      WHERE entities_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    binds = [query, limit];
  }

  try {
    const stmt   = env.DB.prepare(sql);
    const bound  = (stmt.bind as (...args: unknown[]) => D1PreparedStatement)(...binds);
    const result = await bound.all<{
      id: string; type: string; name: string;
      tags: string; updated_at: number; excerpt: string;
    }>();
    return {
      total:   result.results.length,
      results: result.results,
    };
  } catch (err) {
    return { error: `findEntities failed: ${String(err)}` };
  }
}

export async function executeGetEntity(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const id = String(args.id ?? '').trim();
  if (!id) return { error: 'id is required' };

  try {
    const entity = await env.DB
      .prepare('SELECT * FROM entities WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();

    if (!entity) return { error: `Entity "${id}" not found` };

    // Parse data JSON for cleaner output
    try { entity.data = JSON.parse(entity.data as string); } catch {}

    return entity;
  } catch (err) {
    return { error: `getEntity failed: ${String(err)}` };
  }
}

export async function executeCreateEntity(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const type = String(args.type ?? '').trim().toLowerCase();
  const name = String(args.name ?? '').trim();
  const tags = String(args.tags ?? '').trim();
  const data = safeJson(args.data);
  const note = String(args.note ?? '').trim();

  if (!type) return { error: 'type is required' };
  if (!name) return { error: 'name is required' };

  const id        = uuid();
  const ts        = now();
  const noteEntry = note ? `[${timestamp()}] ${note}` : '';

  try {
    await env.DB
      .prepare(`
        INSERT INTO entities (id, type, name, tags, notes, data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(id, type, name, tags, noteEntry, data, ts, ts)
      .run();

    return { ok: true, id, type, name };
  } catch (err) {
    return { error: `createEntity failed: ${String(err)}` };
  }
}

export async function executeUpdateEntity(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const id = String(args.id ?? '').trim();
  if (!id) return { error: 'id is required' };

  // Verify entity exists
  const existing = await env.DB
    .prepare('SELECT id, data FROM entities WHERE id = ?')
    .bind(id)
    .first<{ id: string; data: string }>();

  if (!existing) return { error: `Entity "${id}" not found` };

  const updates: string[] = [];
  const binds:   unknown[] = [];

  // Update name if provided
  if (args.name) {
    updates.push('name = ?');
    binds.push(String(args.name).trim());
  }

  // Update tags if provided
  if (args.tags !== undefined) {
    updates.push('tags = ?');
    binds.push(String(args.tags).trim());
  }

  // Patch data JSON — merge with existing, don't replace
  if (args.data) {
    let existingData: Record<string, unknown> = {};
    try { existingData = JSON.parse(existing.data); } catch {}

    let patchData: Record<string, unknown> = {};
    try {
      patchData = JSON.parse(safeJson(args.data));
    } catch {
      return { error: 'data must be a valid JSON object string' };
    }

    const merged = { ...existingData, ...patchData };
    updates.push('data = ?');
    binds.push(JSON.stringify(merged));
  }

  if (!updates.length) return { error: 'Nothing to update — provide name, tags, or data' };

  updates.push('updated_at = ?');
  binds.push(now());
  binds.push(id);

  try {
    await env.DB
      .prepare(`UPDATE entities SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();

    return { ok: true, id, updated: updates.filter(u => !u.startsWith('updated_at')) };
  } catch (err) {
    return { error: `updateEntity failed: ${String(err)}` };
  }
}

export async function executeAppendEntityNote(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const id   = String(args.id   ?? '').trim();
  const note = String(args.note ?? '').trim();

  if (!id)   return { error: 'id is required' };
  if (!note) return { error: 'note is required' };

  const entry = `[${timestamp()}] ${note}`;

  try {
    const result = await env.DB
      .prepare(`
        UPDATE entities
        SET notes      = CASE WHEN notes = '' THEN ? ELSE notes || char(10) || ? END,
            updated_at = ?
        WHERE id = ?
      `)
      .bind(entry, entry, now(), id)
      .run();

    if (result.meta.changes === 0) return { error: `Entity "${id}" not found` };

    return { ok: true, id, entry };
  } catch (err) {
    return { error: `appendEntityNote failed: ${String(err)}` };
  }
}

export async function executeDeleteEntity(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const id = String(args.id ?? '').trim();
  if (!id) return { error: 'id is required' };

  try {
    // Relations cascade via ON DELETE CASCADE
    const result = await env.DB
      .prepare('DELETE FROM entities WHERE id = ?')
      .bind(id)
      .run();

    if (result.meta.changes === 0) return { error: `Entity "${id}" not found` };

    return { ok: true, id, deleted: true };
  } catch (err) {
    return { error: `deleteEntity failed: ${String(err)}` };
  }
}

export async function executeLinkEntities(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const fromId   = String(args.from_id  ?? '').trim();
  const toId     = String(args.to_id    ?? '').trim();
  const relation = String(args.relation ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  const notes    = String(args.notes    ?? '').trim();

  if (!fromId)   return { error: 'from_id is required' };
  if (!toId)     return { error: 'to_id is required' };
  if (!relation) return { error: 'relation is required' };

  // Verify both entities exist
  const [from, to] = await Promise.all([
    env.DB.prepare('SELECT id, name FROM entities WHERE id = ?').bind(fromId).first<{ id: string; name: string }>(),
    env.DB.prepare('SELECT id, name FROM entities WHERE id = ?').bind(toId).first<{ id: string; name: string }>(),
  ]);

  if (!from) return { error: `Source entity "${fromId}" not found` };
  if (!to)   return { error: `Target entity "${toId}" not found` };

  const id = uuid();
  const ts = now();

  try {
    await env.DB
      .prepare(`
        INSERT INTO entity_relations (id, from_id, to_id, relation, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(id, fromId, toId, relation, notes, ts)
      .run();

    return {
      ok:       true,
      id,
      from:     { id: fromId, name: from.name },
      relation,
      to:       { id: toId,   name: to.name   },
    };
  } catch (err) {
    return { error: `linkEntities failed: ${String(err)}` };
  }
}

export async function executeGetRelations(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const id        = String(args.id        ?? '').trim();
  const direction = String(args.direction ?? 'both').trim().toLowerCase();
  const relation  = String(args.relation  ?? '').trim();

  if (!id) return { error: 'id is required' };

  const outgoing: unknown[] = [];
  const incoming: unknown[] = [];

  try {
    // Outgoing edges: this entity → others
    if (direction === 'out' || direction === 'both') {
      const relFilter = relation ? 'AND r.relation = ?' : '';
      const binds     = relation ? [id, relation] : [id];

      const out = await env.DB
        .prepare(`
          SELECT r.id, r.relation, r.notes, r.created_at,
                 e.id AS target_id, e.name AS target_name, e.type AS target_type
          FROM entity_relations r
          JOIN entities e ON r.to_id = e.id
          WHERE r.from_id = ? ${relFilter}
          ORDER BY r.created_at DESC
        `)
        .bind(...binds)
        .all<Record<string, unknown>>();

      outgoing.push(...(out.results ?? []));
    }

    // Incoming edges: others → this entity
    if (direction === 'in' || direction === 'both') {
      const relFilter = relation ? 'AND r.relation = ?' : '';
      const binds     = relation ? [id, relation] : [id];

      const inc = await env.DB
        .prepare(`
          SELECT r.id, r.relation, r.notes, r.created_at,
                 e.id AS source_id, e.name AS source_name, e.type AS source_type
          FROM entity_relations r
          JOIN entities e ON r.from_id = e.id
          WHERE r.to_id = ? ${relFilter}
          ORDER BY r.created_at DESC
        `)
        .bind(...binds)
        .all<Record<string, unknown>>();

      incoming.push(...(inc.results ?? []));
    }

    return {
      id,
      outgoing: direction !== 'in' ? outgoing : undefined,
      incoming: direction !== 'out' ? incoming : undefined,
    };
  } catch (err) {
    return { error: `getRelations failed: ${String(err)}` };
  }
}

export async function executeDefineSchema(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const type        = String(args.type         ?? '').trim().toLowerCase();
  const displayName = String(args.display_name ?? '').trim();
  const description = String(args.description  ?? '').trim();
  const fields      = safeJson(args.fields, '[]');

  if (!type)        return { error: 'type is required' };
  if (!displayName) return { error: 'display_name is required' };

  // Validate fields is a JSON array
  try {
    const parsed = JSON.parse(fields);
    if (!Array.isArray(parsed)) return { error: 'fields must be a JSON array' };
  } catch {
    return { error: 'fields must be valid JSON' };
  }

  const ts = now();

  try {
    await env.DB
      .prepare(`
        INSERT INTO entity_schemas (type, display_name, description, fields, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(type) DO UPDATE SET
          display_name = excluded.display_name,
          description  = excluded.description,
          fields       = excluded.fields,
          updated_at   = excluded.updated_at
      `)
      .bind(type, displayName, description, fields, ts, ts)
      .run();

    return { ok: true, type, display_name: displayName };
  } catch (err) {
    return { error: `defineSchema failed: ${String(err)}` };
  }
}

export async function executeGetSchema(
  args: Record<string, unknown>,
  env:  Env,
): Promise<unknown> {
  const type = String(args.type ?? '').trim().toLowerCase();

  try {
    if (type) {
      // Fetch specific schema
      const schema = await env.DB
        .prepare('SELECT * FROM entity_schemas WHERE type = ?')
        .bind(type)
        .first<Record<string, unknown>>();

      if (!schema) {
        return {
          error: `Schema for type "${type}" not found.`,
          hint:  'Call defineSchema to create it, or call getSchema without a type to see available types.',
        };
      }

      try { schema.fields = JSON.parse(schema.fields as string); } catch {}
      return schema;
    }

    // List all schemas (slim view)
    const result = await env.DB
      .prepare('SELECT type, display_name, description FROM entity_schemas ORDER BY type')
      .all<{ type: string; display_name: string; description: string }>();

    return {
      types: result.results ?? [],
      hint:  'Call getSchema with a specific type to see its field definitions.',
    };
  } catch (err) {
    return { error: `getSchema failed: ${String(err)}` };
  }
}