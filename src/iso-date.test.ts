import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIsoDate } from "./iso-date.js";

describe("parseIsoDate", () => {
    it("accepts a date-only value as UTC midnight", () => {
        assert.equal(parseIsoDate("2026-03-25"), Date.UTC(2026, 2, 25));
    });

    it("accepts date-time, seconds, milliseconds, and offsets", () => {
        for (const value of [
            "2026-03-25T10:00",
            "2026-03-25T10:00:30",
            "2026-03-25T10:00:30.500",
            "2026-03-25T10:00:30Z",
            "2026-03-25T10:00:30+13:00",
            "2026-03-25T10:00:30-05:00",
        ]) {
            assert.equal(parseIsoDate(value), new Date(value).getTime(), value);
        }
    });

    it("rejects loose numeric values that new Date() would accept", () => {
        // new Date("1") is 2001-01-01, not an error — the whole point of this module.
        for (const value of ["0", "1", "2", "1999", "20260325"]) {
            assert.equal(parseIsoDate(value), null, value);
        }
    });

    it("rejects impossible calendar dates instead of rolling them over", () => {
        // new Date("2024-02-30") silently becomes 2024-03-01.
        for (const value of ["2024-02-30", "2023-02-29", "1900-02-29", "2026-04-31", "2026-00-10", "2026-01-00"]) {
            assert.equal(parseIsoDate(value), null, value);
        }
    });

    it("accepts real leap days", () => {
        assert.equal(parseIsoDate("2024-02-29"), Date.UTC(2024, 1, 29));
        assert.equal(parseIsoDate("2000-02-29"), Date.UTC(2000, 1, 29));
    });

    it("rejects out-of-range months, days, and times", () => {
        for (const value of ["2026-13-01", "2026-03-25T24:00", "2026-03-25T10:60", "2026-03-25T10:00:60"]) {
            assert.equal(parseIsoDate(value), null, value);
        }
    });

    it("rejects non-ISO shapes", () => {
        for (const value of ["", "bad date", "yesterday", "2026-3-25", "25/03/2026", "2026-03-25 10:00", "2026-03-25T10", "Mar 25 2026"]) {
            assert.equal(parseIsoDate(value), null, JSON.stringify(value));
        }
    });

    it("rejects an out-of-range UTC offset that passes the shape check", () => {
        assert.equal(parseIsoDate("2026-03-25T10:00+25:00"), null);
    });
});
