import { describe, expect, it } from 'vitest';
import { calendarDate } from '../src/dates.js';

describe('calendar dates', () => {
  it('keeps a YYYY-MM-DD string on the same day in Australia/Adelaide', () => {
    expect(calendarDate('2026-04-18', { timeZone: 'Australia/Adelaide' })).toBe('2026-04-18');
  });

  it('keeps an API UTC-midnight timestamp on that calendar day', () => {
    expect(calendarDate('2026-04-18T00:00:00.000Z', { timeZone: 'America/Los_Angeles' })).toBe('2026-04-18');
    expect(calendarDate('2026-04-18T00:00:00.000Z', { timeZone: 'Australia/Adelaide' })).toBe('2026-04-18');
  });

  it('formats a Date instant in Australia/Adelaide instead of UTC', () => {
    const instant = new Date('2026-04-17T15:00:00.000Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-04-17');
    expect(calendarDate(instant, { timeZone: 'Australia/Adelaide' })).toBe('2026-04-18');
  });

  it('parses an Australian day-month-year date', () => {
    expect(calendarDate('18/04/2026', { dateOrder: 'DMY', timeZone: 'Australia/Adelaide' })).toBe('2026-04-18');
  });

  it('rejects a calendar date that does not exist', () => {
    expect(() => calendarDate('2026-02-31')).toThrow(/invalid/);
  });
});
