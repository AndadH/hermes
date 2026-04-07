import { describe, it, expect } from 'vitest';
import { calendarUrl } from '../src/tools/calendar';
import type { Env } from '../src/types';

describe('API Safety: Google Calendar URL Construction', () => {
  const mockEnv = { GOOGLE_CALENDAR_ID: 'andrew@example.com' } as Env;

  it('4. constructs the base URL correctly without an eventId', () => {
    const url = calendarUrl(mockEnv);
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/andrew%40example.com/events');
  });

  it('5. appends the eventId correctly when provided', () => {
    const url = calendarUrl(mockEnv, 'evt_12345');
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/andrew%40example.com/events/evt_12345');
  });

  it('6. safely URL-encodes special characters in the calendar ID and event ID', () => {
    const maliciousEnv = { GOOGLE_CALENDAR_ID: 'my_cal?&evil=true' } as Env;
    const url = calendarUrl(maliciousEnv, 'event/with/slashes');
    
    // The ? and & and / MUST be percent-encoded to prevent API hijacking
    expect(url).not.toContain('?&evil=true');
    expect(url).not.toContain('event/with/slashes');
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/my_cal%3F%26evil%3Dtrue/events/event%2Fwith%2Fslashes');
  });
});