import type { Env, AgentContext } from '../types';

// ── Gemini function declarations ──────────────────────────────────────────────

export const calendarDeclarations = [
  {
    name: 'getCalendarEvents',
    description: 'Retrieve upcoming calendar events for the admin. Use to check schedule, availability, or existing bookings.',
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
    description: 'Create a new event on the admin calendar.',
    parameters: {
      type: 'OBJECT',
      properties: {
        summary: { type: 'STRING', description: 'The event title/name. Use the field name "summary" exactly.' },
        startTime: { type: 'STRING', description: 'ISO string of the exact start time.' },
        endTime: { type: 'STRING', description: 'ISO string of the exact end time.' },
        description: { type: 'STRING', description: 'Optional. Details or context for the event.' },
      },
      required: ['summary', 'startTime', 'endTime'],
    },
  },
];

// ── Google Auth ───────────────────────────────────────────────────────────────

async function getGoogleAuthToken(env: Env): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: env.GOOGLE_CAL_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodeBase64Url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const encodedHeader = encodeBase64Url(header);
  const encodedClaimSet = encodeBase64Url(claimSet);
  const unsignedJwt = `${encodedHeader}.${encodedClaimSet}`;

  // Import the private key from PEM
  const pemKey = env.GOOGLE_CAL_PRIVATE_KEY.replace(/\\n/g, '\n');
  const pemContents = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedJwt),
  );

  const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const jwt = `${unsignedJwt}.${signature}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const tokenData: any = await tokenRes.json();
  return tokenData.access_token;
}

// ── Execute: getCalendarEvents ────────────────────────────────────────────────

export async function executeGetCalendarEvents(
  env: Env,
  _ctx: AgentContext,
  args: { timeMin?: string; timeMax?: string },
): Promise<unknown> {
  try {
    const token = await getGoogleAuthToken(env);
    const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);

    const now = new Date();
    const timeMin = args.timeMin ?? now.toISOString();
    const timeMax =
      args.timeMax ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events` +
      `?timeMin=${encodeURIComponent(timeMin)}` +
      `&timeMax=${encodeURIComponent(timeMax)}` +
      `&singleEvents=true&orderBy=startTime`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const err = await res.text();
      return { error: `Calendar API error: ${err}` };
    }

    const data: any = await res.json();
    const events = (data.items ?? []).map((e: any) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      description: e.description,
      htmlLink: e.htmlLink,
    }));

    return { events, count: events.length };
  } catch (err) {
    console.error('[getCalendarEvents] Error:', err);
    return { error: 'Failed to fetch calendar events.' };
  }
}

// ── Execute: createCalendarEvent ──────────────────────────────────────────────

export async function executeCreateCalendarEvent(
  env: Env,
  _ctx: AgentContext,
  args: { summary: string; startTime: string; endTime: string; description?: string },
): Promise<unknown> {
  try {
    const token = await getGoogleAuthToken(env);
    const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);

    const event = {
      summary: args.summary,
      description: args.description,
      start: { dateTime: args.startTime },
      end: { dateTime: args.endTime },
    };

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      return { success: false, error: `Calendar API error: ${err}` };
    }

    const data: any = await res.json();
    return {
      success: true,
      eventLink: data.htmlLink,
      eventId: data.id,
    };
  } catch (err) {
    console.error('[createCalendarEvent] Error:', err);
    return { success: false, error: 'Failed to create calendar event.' };
  }
}