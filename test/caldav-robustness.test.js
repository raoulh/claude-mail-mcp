/**
 * Regression tests for the calendar path, same bug class as the mail listing:
 * a single unreadable item used to abort the entire response.
 *
 * ical.js fails in three distinct ways here, all previously fatal to
 * list_events (and therefore to find_free_slot, which calls it):
 *   - ICAL.parse throws a ParserError on a malformed .ics;
 *   - `event.startDate` THROWS `invalid date-time value` on DTSTART:GARBAGE;
 *   - `event.startDate` returns null when DTSTART is missing, so `.toJSDate()`
 *     throws a TypeError and `endDate` throws dereferencing it.
 *
 * Run against the compiled output: `npm test` builds first.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CalDavClient } from "../dist/caldav-client.js";

const AUTH = {
  serverUrl: "https://example.invalid/dav/",
  username: "u",
  password: "p",
};

function ics(body) {
  return (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n" +
    body +
    "END:VCALENDAR\r\n"
  );
}

const GOOD_EVENT = ics(
  "BEGIN:VEVENT\r\nUID:good-1\r\nSUMMARY:Standup\r\n" +
    "DTSTART:20260811T090000Z\r\nDTEND:20260811T093000Z\r\nEND:VEVENT\r\n"
);
const LATER_EVENT = ics(
  "BEGIN:VEVENT\r\nUID:good-2\r\nSUMMARY:Retro\r\n" +
    "DTSTART:20260811T140000Z\r\nDTEND:20260811T150000Z\r\nEND:VEVENT\r\n"
);
const BAD_DTSTART = ics(
  "BEGIN:VEVENT\r\nUID:bad-dtstart\r\nSUMMARY:Broken start\r\n" +
    "DTSTART:GARBAGE\r\nEND:VEVENT\r\n"
);
const NO_DTSTART = ics(
  "BEGIN:VEVENT\r\nUID:no-dtstart\r\nSUMMARY:No start at all\r\nEND:VEVENT\r\n"
);
const NOT_ICAL_AT_ALL = "this is not ical at all";

/** CalDavClient with its DAV layer replaced by canned calendar objects. */
function clientReturning(objects) {
  const c = new CalDavClient(AUTH);
  // `private` is erased at runtime; shadow the members on the instance.
  c.findCalendar = async () => ({ url: AUTH.serverUrl, displayName: "cal" });
  c.ensureClient = async () => ({
    fetchCalendarObjects: async () => objects,
  });
  return c;
}

const WINDOW = ["2026-08-11T00:00:00Z", "2026-08-12T00:00:00Z"];

test("list_events survives an .ics that does not parse at all", async () => {
  const c = clientReturning([
    { url: "/c/good.ics", data: GOOD_EVENT },
    { url: "/c/junk.ics", data: NOT_ICAL_AT_ALL },
    { url: "/c/later.ics", data: LATER_EVENT },
  ]);
  // A rejection here fails the test outright — that is the regression.
  const events = await c.listEvents(AUTH.serverUrl, ...WINDOW);
  assert.deepEqual(
    events.map((e) => e.uid),
    ["good-1", "good-2"],
    "the readable events must still come back"
  );
});

test("list_events keeps events whose DTSTART is malformed or missing", async () => {
  const c = clientReturning([
    { url: "/c/good.ics", data: GOOD_EVENT },
    { url: "/c/bad.ics", data: BAD_DTSTART },
    { url: "/c/none.ics", data: NO_DTSTART },
  ]);
  const events = await c.listEvents(AUTH.serverUrl, ...WINDOW);

  assert.equal(events.length, 3, "no event may be silently dropped");
  const byUid = Object.fromEntries(events.map((e) => [e.uid, e]));

  assert.equal(byUid["good-1"].start, "2026-08-11T09:00:00.000Z");
  assert.equal(byUid["good-1"].end, "2026-08-11T09:30:00.000Z");

  // Unreadable dates become null instead of throwing, and the event stays
  // identifiable.
  assert.equal(byUid["bad-dtstart"].start, null);
  assert.equal(byUid["bad-dtstart"].end, null);
  assert.equal(byUid["no-dtstart"].start, null);
  assert.equal(byUid["no-dtstart"].end, null);
  assert.equal(byUid["no-dtstart"].summary, "No start at all");

  // Undated events sort last rather than throwing on localeCompare(null).
  assert.equal(events[0].uid, "good-1");
  assert.equal(events.at(-1).start, null);

  assert.doesNotThrow(() => JSON.stringify(events));
});

test("list_events sorts undated events last without throwing", async () => {
  const c = clientReturning([
    { url: "/c/none.ics", data: NO_DTSTART },
    { url: "/c/later.ics", data: LATER_EVENT },
    { url: "/c/good.ics", data: GOOD_EVENT },
  ]);
  const events = await c.listEvents(AUTH.serverUrl, ...WINDOW);
  assert.deepEqual(
    events.map((e) => e.uid),
    ["good-1", "good-2", "no-dtstart"]
  );
});

test("find_free_slot ignores undated events instead of losing every slot", async () => {
  // The undated event previously turned `cursor` into NaN through
  // Math.max(cursor, NaN), after which every remaining slot was dropped.
  const c = clientReturning([
    { url: "/c/good.ics", data: GOOD_EVENT }, // busy 09:00-09:30
    { url: "/c/none.ics", data: NO_DTSTART }, // undated
  ]);
  const slots = await c.findFreeSlots([AUTH.serverUrl], ...WINDOW, 60);

  assert.ok(slots.length > 0, "free slots must still be reported");
  assert.doesNotThrow(() => JSON.stringify(slots));
  for (const s of slots) {
    assert.ok(Number.isFinite(Date.parse(s.start)), `bad start ${s.start}`);
    assert.ok(Number.isFinite(Date.parse(s.end)), `bad end ${s.end}`);
  }
  // The real event is still treated as busy: no slot straddles 09:00-09:30.
  const busyStart = Date.parse("2026-08-11T09:00:00Z");
  const busyEnd = Date.parse("2026-08-11T09:30:00Z");
  for (const s of slots) {
    const overlaps =
      Date.parse(s.start) < busyEnd && Date.parse(s.end) > busyStart;
    assert.equal(overlaps, false, `slot ${s.start}..${s.end} overlaps a busy event`);
  }
});

test("find_free_slot rejects unparsable bounds instead of answering 'none'", async () => {
  const c = clientReturning([{ url: "/c/good.ics", data: GOOD_EVENT }]);
  await assert.rejects(
    () => c.findFreeSlots([AUTH.serverUrl], "garbage", WINDOW[1], 60),
    /must be ISO 8601 datetimes/
  );
});
