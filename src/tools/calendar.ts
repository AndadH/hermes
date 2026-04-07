// src/tools/calendar.ts
import type { Env, AgentContext } from '../types';

// ── Gemini function declarations ──────────────────────────────────────────────

export const calendarDeclarations = [
  {
    name: 'getCalendarEvents',
    description: 'Retrieve upcoming calendar events. Use to check schedule, availability, or find an event ID before deleting or updating.',
    parameters: {
      type: 'OBJECT',
      properties: {
        timeMin: { type: 'STRING', description: 'Optional ISO string for range start. Defaults to now.' },
        timeMax: { type: 'STRING', description: 'Optional ISO string for range end. Defaults to 7 days from now.' },
      },
      required: [],
    },
  },
  {
    name: 'createCalendarEvent',
    description: 'Create a new event on the calendar. Returns an eventLink — always include it in your response so the user can open the event.',
    parameters: {
      type: 'OBJECT',
      properties: {
        summary:     { type: 'STRING', description: 'Event title. Use "summary" exactly.' },
        startTime:   { type: 'STRING', description: 'ISO string of start time.' },
        endTime:     { type: 'STRING', description: 'ISO string of end time.' },
        description: { type: 'STRING', description: 'Optional details or context.' },
      },
      required: ['summary', 'startTime', 'endTime'],
    },
  },
  {
    name: 'deleteCalendarEvent',
    description:
      'Delete a calendar event by its ID. ' +
      'Always call getCalendarEvents first to find the event ID. ' +
      'This is permanent — confirm intent before calling.',
    parameters: {
      type: 'OBJECT',
      properties: {
        eventId: { type: 'STRING', description: 'The event ID from getCalendarEvents.' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'updateCalendarEvent',
    description:
      'Update an existing calendar event — change its title, time, or description. ' +
      'Always call getCalendarEvents first to find the event ID. ' +
      'Only provide fields you want to change. ' +
      'Returns an eventLink — always include it in your response so the user can verify the change.',
    parameters: {
      type: 'OBJECT',
      properties: {
        eventId:     { type: 'STRING', description: 'The event ID from getCalendarEvents.' },
        summary:     { type: 'STRING', description: 'New event title. Omit to keep existing.' },
        startTime:   { type: 'STRING', description: 'New ISO start time. Omit to keep existing.' },
        endTime:     { type: 'STRING', description: 'New ISO end time. Omit to keep existing.' },
        description: { type: 'STRING', description: 'New description. Omit to keep existing.' },
      },
      required: ['eventId'],
    },
  },
];

// ── Google Auth ───────────────────────────────────────────────────────────────

async function getGoogleAuthToken(env: Env): Promise<string> {
  const header   = { alg: 'RS256', typ: 'JWT' };
  const now      = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss:   env.GOOGLE_CAL_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };

  const encodeBase64Url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  const unsignedJwt = encodeBase64Url(header) + '.' + encodeBase64Url(claimSet);

  const pemKey      = env.GOOGLE_CAL_PRIVATE_KEY.replace(/\\n/g, '\n');
  const pemContents = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );

  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsignedJwt));
  const sig    = btoa(String.fromCharCode(...new Uint8Array(sigBuf))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt    = unsignedJwt + '.' + sig;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });

  if (!tokenRes.ok) throw new Error('Google token exchange failed: ' + await tokenRes.text());
  return ((await tokenRes.json()) as any).access_token;
}

export function calendarUrl(env: Env, eventId?: string): string {
  const base = 'https://www.googleapis.com/calendar/v3/calendars/' +
    encodeURIComponent(env.GOOGLE_CALENDAR_ID) + '/events';
  return eventId ? base + '/' + encodeURIComponent(eventId) : base;
}

// ── Execute: getCalendarEvents ────────────────────────────────────────────────

export async function executeGetCalendarEvents(
  env:  Env,
  _ctx: AgentContext,
  args: { timeMin?: string; timeMax?: string },
): Promise<unknown> {
  try {
    const token   = await getGoogleAuthToken(env);
    const now     = new Date();
    const timeMin = args.timeMin ?? now.toISOString();
    const timeMax = args.timeMax ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const url = calendarUrl(env) +
      '?timeMin=' + encodeURIComponent(timeMin) +
      '&timeMax=' + encodeURIComponent(timeMax) +
      '&singleEvents=true&orderBy=startTime';

    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return { error: 'Calendar API error: ' + await res.text() };

    const data: any = await res.json();
    const events = (data.items ?? []).map((e: any) => ({
      id:          e.id,
      summary:     e.summary,
      start:       e.start?.dateTime ?? e.start?.date,
      end:         e.end?.dateTime   ?? e.end?.date,
      description: e.description,
      htmlLink:    e.htmlLink,
    }));

    return { events, count: events.length };
  } catch (err) {
    console.error('[getCalendarEvents] Error:', err);
    return { error: 'Failed to fetch calendar events.' };
  }
}

// ── Execute: createCalendarEvent ──────────────────────────────────────────────

export async function executeCreateCalendarEvent(
  env:  Env,
  _ctx: AgentContext,
  args: { summary: string; startTime: string; endTime: string; description?: string },
): Promise<unknown> {
  try {
    const token = await getGoogleAuthToken(env);
    const res   = await fetch(calendarUrl(env), {
      method:  'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        summary:     args.summary,
        description: args.description,
        start:       { dateTime: args.startTime },
        end:         { dateTime: args.endTime },
      }),
    });

    if (!res.ok) return { success: false, error: 'Calendar API error: ' + await res.text() };
    const data: any = await res.json();
    return { success: true, eventId: data.id, eventLink: data.htmlLink };
  } catch (err) {
    console.error('[createCalendarEvent] Error:', err);
    return { success: false, error: 'Failed to create calendar event.' };
  }
}

// ── Execute: deleteCalendarEvent ──────────────────────────────────────────────

export async function executeDeleteCalendarEvent(
  env:  Env,
  _ctx: AgentContext,
  args: { eventId: string },
): Promise<unknown> {
  if (!args.eventId?.trim()) return { error: 'eventId is required' };

  try {
    const token = await getGoogleAuthToken(env);
    const res   = await fetch(calendarUrl(env, args.eventId), {
      method:  'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    });

    // 204 = success (no content), 404 = already gone
    if (res.status === 204) return { success: true, eventId: args.eventId };
    if (res.status === 404) return { success: false, error: 'Event not found — may have already been deleted.' };

    return { success: false, error: 'Calendar API error ' + res.status + ': ' + await res.text() };
  } catch (err) {
    console.error('[deleteCalendarEvent] Error:', err);
    return { success: false, error: 'Failed to delete calendar event.' };
  }
}

// ── Execute: updateCalendarEvent ──────────────────────────────────────────────

export async function executeUpdateCalendarEvent(
  env:  Env,
  _ctx: AgentContext,
  args: { eventId: string; summary?: string; startTime?: string; endTime?: string; description?: string },
): Promise<unknown> {
  if (!args.eventId?.trim()) return { error: 'eventId is required' };

  try {
    const token = await getGoogleAuthToken(env);

    // PATCH only sends the fields we want to change
    const patch: Record<string, unknown> = {};
    if (args.summary     !== undefined) patch.summary     = args.summary;
    if (args.description !== undefined) patch.description = args.description;
    if (args.startTime   !== undefined) patch.start       = { dateTime: args.startTime };
    if (args.endTime     !== undefined) patch.end         = { dateTime: args.endTime };

    if (Object.keys(patch).length === 0) {
      return { error: 'No fields to update — provide at least one of: summary, startTime, endTime, description.' };
    }

    const res = await fetch(calendarUrl(env, args.eventId) + '?sendUpdates=none', {
      method:  'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    });

    if (!res.ok) return { success: false, error: 'Calendar API error ' + res.status + ': ' + await res.text() };
    const data: any = await res.json();
    return { success: true, eventId: data.id, eventLink: data.htmlLink, updated: Object.keys(patch) };
  } catch (err) {
    console.error('[updateCalendarEvent] Error:', err);
    return { success: false, error: 'Failed to update calendar event.' };
  }
}