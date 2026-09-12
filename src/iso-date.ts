/**
 * Strict ISO 8601 date parsing for the `modified_after` tool filters.
 *
 * `new Date(value)` is far looser than the documented ISO format: it accepts
 * `"1"` (year 2001) and rolls impossible calendar dates over (`"2024-02-30"`
 * becomes 2024-03-01). Both silently apply an unintended search cutoff instead
 * of failing, so the shape and the calendar fields are validated up front.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function daysInMonth(year: number, month: number): number {
    if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Parse a strict ISO date (`2026-03-25`, `2026-03-25T10:00`, with optional
 * seconds, milliseconds, and `Z`/±hh:mm offset) to a timestamp in ms.
 * Returns null for anything else, including impossible calendar dates.
 *
 * Timestamp semantics match `new Date`: a date-only value is UTC midnight,
 * a date-time without an offset is local time.
 */
export function parseIsoDate(value: string): number | null {
    const match = ISO_DATE.exec(value);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    const y = Number(year), mo = Number(month), d = Number(day);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) return null;
    if (second !== undefined && Number(second) > 59) return null;
    const ms = new Date(value).getTime();
    // Out-of-range UTC offsets (e.g. +25:00) survive the shape check.
    return Number.isNaN(ms) ? null : ms;
}
