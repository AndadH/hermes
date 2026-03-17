// src/tools/daily.ts
//
// Two tools for the shared daily journal note at journal/YYYY-MM-DD.md.
//
// readMemory  — read the full note for a given date (defaults to today)
// writeMemory — append a short timestamped bullet to the ## Hermes section
//
// The note structure:
//   [your content — Andrew writes here, Hermes never touches it]
//
//   ## Hermes
//   - HH:MM entry one
//   - HH:MM entry two
//
// Hermes always appends to its own section at the bottom.
// If the note doesn't exist, writeMemory creates it.
// If the note exists but has no ## Hermes section, one is appended.

import type { Env, AgentContext } from '../types';
import { sha256Hex } from './vault';

// ── Config ────────────────────────────────────────────────────────────────────

const JOURNAL_FOLDER  = 'journal';
const HERMES_HEADING  = '## Hermes';
const MAX_ENTRY_CHARS = 280;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayDate(): string {
  // Format manually — toLocaleDateString with en-CA is unreliable in CF Workers
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  const d   = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function parseDate(input: string): string | null {
  // Accept YYYY-MM-DD only — keeps parsing unambiguous
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return input.trim();
  return null;
}

function notePath(date: string): string {
  return JOURNAL_FOLDER + '/' + date + '.md';
}

function currentTime(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Denver',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

// ── Gemini declarations ───────────────────────────────────────────────────────

export const dailyDeclarations = [
  {
    name: 'readMemory',
    description:
      'Read the written memory log for a given date. ' +
      'Contains only things explicitly recorded — not a calendar or schedule. ' +
      'No date = today.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: {
          type: 'STRING',
          description: 'Date in YYYY-MM-DD format. Omit for today.',
        },
      },
      required: [],
    },
  },
  {
    name: 'writeMemory',
    description:
      'Write a short entry to today\'s memory log — appended under a Hermes section, timestamped. ' +
      'Use sparingly, only for things worth remembering across conversations: ' +
      'observations that may need follow-up, actions taken autonomously, ' +
      'things worth recalling later ("Andrew mentioned EU-West outages — check if resolved tomorrow"). ' +
      'Max ' + MAX_ENTRY_CHARS + ' characters. Not for general responses or confirmations.',
    parameters: {
      type: 'OBJECT',
      properties: {
        entry: {
          type: 'STRING',
          description:
            'A short, factual log entry. Written in past or present tense. ' +
            'Max ' + MAX_ENTRY_CHARS + ' characters. ' +
            'Examples: "Andrew mentioned EU-West outages — will check tomorrow if resolved." ' +
            '/ "Scheduled follow-up with Dave for Thursday 9am." ' +
            '/ "Noted: Andrew seems busy today, kept responses brief."',
        },
      },
      required: ['entry'],
    },
  },
];

// ── Executors ─────────────────────────────────────────────────────────────────

export async function executeReadMemory(
  args: Record<string, unknown>,
  env:  Env,
  _ctx: AgentContext,
): Promise<unknown> {
  const rawDate = args.date ? String(args.date).trim() : todayDate();
  const date    = parseDate(rawDate);

  if (!date) {
    return { error: 'Invalid date format. Use YYYY-MM-DD (e.g. "' + todayDate() + '").' };
  }

  const path = notePath(date);
  const obj  = await env.VAULT.get(path);

  if (!obj) {
    return {
      date,
      path,
      exists:  false,
      content: null,
      note:    'No journal entry for ' + date + ' yet.',
    };
  }

  const content = await obj.text();
  return { date, path, exists: true, content };
}

export async function executeWriteMemory(
  args: Record<string, unknown>,
  env:  Env,
  _ctx: AgentContext,
): Promise<unknown> {
  const raw = String(args.entry ?? '').trim();

  if (!raw) return { error: 'entry is required' };

  // Enforce character limit
  const entry = raw.length > MAX_ENTRY_CHARS
    ? raw.slice(0, MAX_ENTRY_CHARS - 1) + '…'
    : raw;

  const date    = todayDate();
  const path    = notePath(date);
  const bullet  = '- ' + currentTime() + ' ' + entry;

  // Load existing note (or start fresh)
  const obj      = await env.VAULT.get(path);
  const existing = obj ? await obj.text() : '';

  let updated: string;

  if (!existing) {
    // No note yet — create with just the Hermes section
    updated = HERMES_HEADING + '\n' + bullet + '\n';
  } else if (existing.includes(HERMES_HEADING)) {
    // Append bullet under the existing ## Hermes section
    // Insert just before any trailing newlines to keep formatting clean
    const idx = existing.lastIndexOf(HERMES_HEADING);
    const afterHeading = existing.slice(idx + HERMES_HEADING.length);
    // Find the end of the Hermes section (next ## heading or end of file)
    const nextHeadingMatch = afterHeading.match(/\n##\s/);
    if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
      // There's another section after Hermes — insert before it
      const insertAt = idx + HERMES_HEADING.length + nextHeadingMatch.index;
      updated =
        existing.slice(0, insertAt).trimEnd() + '\n' +
        bullet + '\n' +
        existing.slice(insertAt);
    } else {
      // Hermes section runs to end of file
      updated = existing.trimEnd() + '\n' + bullet + '\n';
    }
  } else {
    // Note exists but no Hermes section — append at bottom
    updated = existing.trimEnd() + '\n\n' + HERMES_HEADING + '\n' + bullet + '\n';
  }

  await env.VAULT.put(path, updated, {
    httpMetadata: { contentType: 'text/markdown' },
  });

  // Register in D1 so the sync manifest includes this file.
  // Without this, Obsidian's sync never knows the file exists on the server.
  const now         = Date.now();
  const contentHash = await sha256Hex(updated);
  const size        = new TextEncoder().encode(updated).length;
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO vaultFiles (path, contentHash, updatedAt, size)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        contentHash = excluded.contentHash,
        updatedAt   = excluded.updatedAt,
        size        = excluded.size
    `).bind(path, contentHash, now, size),
    env.DB.prepare('DELETE FROM deletedFiles WHERE path = ?').bind(path),
  ]);

  return { ok: true, date, path, entry: bullet };
}