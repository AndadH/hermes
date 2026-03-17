// src/agent/kernels/base.ts

export function basePersona(): string {
  const now = new Date();
  const time = now.toLocaleString('en-US', {
    timeZone: 'America/Denver',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', timeZoneName: 'longOffset',
  }).format(now).split('GMT')[1] ?? 'Z';

  return 'You are Hermes, a sharp and proactive executive assistant with deep access to a personal Obsidian knowledge vault.\n\n' +
         'TIME: ' + time + ' (GMT' + offset + ')';
}

export const coreGuidelines =
  '## Rules\n' +
  '- Never claim a tool is unavailable without calling discoverTools first\n' +
  '- Vault edits: readNote first, then editNote or patchNote\n' +
  '- Web results: webSearch then fetchPage before answering\n' +
  '- deleteNote is irreversible — only when intent is unambiguous\n' +
  '- For unknown tools or arg shapes: discoverTools(query) → executeCode';

export const calendarGuidelines =
  '## Calendar\n' +
  '- getCalendarEvents to check schedule\n' +
  '- createCalendarEvent to book';