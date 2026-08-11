/**
 * Regression tests for the "Invalid time value" mailbox-wide failure.
 *
 * A single message with a malformed `Date:` header used to abort list_messages
 * and search_messages entirely, making the whole mailbox unreadable and the
 * offending message impossible to inspect or move.
 *
 * Run against the compiled output: `npm test` builds first.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  toIsoOrNull,
  safeMessageDate,
  compareByDateDesc,
} from "../dist/safe-date.js";
import { summarize } from "../dist/imap-client.js";

/**
 * Build a fetch record shaped like what imapflow yields.
 *
 * Note `envelope.date`: imapflow's parseEnvelope assigns a `Date` when the
 * header parses and the RAW HEADER STRING when it does not — even though its
 * typings declare the field as `Date`. Both shapes are exercised below.
 */
function fakeMessage({ uid, envelopeDate, internalDate, subject = "s" }) {
  return {
    uid,
    seq: uid,
    flags: new Set(["\\Seen"]),
    size: 1234,
    internalDate,
    envelope: {
      date: envelopeDate,
      subject,
      from: [{ name: "Someone", address: "someone@example.com" }],
      to: [{ address: "me@example.com" }],
    },
  };
}

const GOOD_DATE = new Date("2026-08-01T10:00:00.000Z");
const INTERNAL = new Date("2026-08-02T12:34:56.000Z");

test("root cause: the old formatting expression really does throw", () => {
  // This is verbatim what src/imap-client.ts used to do. Documented here so the
  // regression is unambiguous.
  assert.throws(
    () => new Date("garbage").toISOString(),
    /Invalid time value/,
    "expected RangeError: Invalid time value"
  );
  // And the old truthiness guard `env?.date ? ... : null` did not protect us,
  // because a raw non-empty header string is truthy.
  assert.ok(Boolean("Fri, 32 Zzz 2099 99:99:99"));
});

/**
 * Verbatim `Date:` header of the spam message that took down INBOX in
 * production. Note the doubled time and timezone: "09:02:34 GMT 00:00:0 -0000".
 */
const REAL_WORLD_BAD_HEADER =
  "Tue, 11 Aug 2026 09:02:34 GMT 00:00:0 -0000 (UTC) ";

test("production repro: the real spam header is unparsable and used to throw", () => {
  const d = new Date(REAL_WORLD_BAD_HEADER);
  assert.equal(Number.isFinite(d.getTime()), false, "must be an Invalid Date");
  assert.throws(() => d.toISOString(), /Invalid time value/);

  // Because it does not parse, imapflow's parseEnvelope stores the RAW STRING
  // in envelope.date rather than a Date — the shape the old truthiness guard
  // sailed straight past.
  assert.equal(typeof REAL_WORLD_BAD_HEADER, "string");
  assert.ok(Boolean(REAL_WORLD_BAD_HEADER));
});

test("production repro: listing the real spam message no longer throws", () => {
  // No INTERNALDATE available -> date must be null, not an exception.
  let bare;
  assert.doesNotThrow(() => {
    bare = summarize(
      fakeMessage({ uid: 4242, envelopeDate: REAL_WORLD_BAD_HEADER })
    );
  });
  assert.equal(bare.date, null);
  assert.equal(bare.uid, 4242, "the message must stay addressable");

  // With INTERNALDATE (the normal case on a real server) we report that.
  const withInternal = summarize(
    fakeMessage({
      uid: 4242,
      envelopeDate: REAL_WORLD_BAD_HEADER,
      internalDate: new Date("2026-08-11T09:03:06.000Z"),
    })
  );
  assert.equal(withInternal.date, "2026-08-11T09:03:06.000Z");

  // And the whole listing survives it, which is the actual production symptom.
  const inbox = [
    fakeMessage({ uid: 1, envelopeDate: GOOD_DATE }),
    fakeMessage({ uid: 4242, envelopeDate: REAL_WORLD_BAD_HEADER }),
    fakeMessage({ uid: 4243, envelopeDate: GOOD_DATE }),
  ];
  let listed;
  assert.doesNotThrow(() => {
    listed = inbox.map(summarize);
  });
  assert.equal(listed.length, 3);
  assert.doesNotThrow(() => JSON.stringify(listed));
});

test("toIsoOrNull accepts every shape imapflow can hand back", () => {
  assert.equal(toIsoOrNull(GOOD_DATE), "2026-08-01T10:00:00.000Z");
  assert.equal(
    toIsoOrNull("Sat, 01 Aug 2026 10:00:00 +0000"),
    "2026-08-01T10:00:00.000Z"
  );
  assert.equal(toIsoOrNull(GOOD_DATE.getTime()), "2026-08-01T10:00:00.000Z");
});

test("absurd-but-representable dates pass through rather than crashing", () => {
  // Year 100000 is still inside the ECMAScript range (max year 275760), so it
  // is a *valid* time value. We must not crash on it, and we must not silently
  // invent a policy about how far in the future a mail may claim to be — it
  // round-trips as an expanded-year ISO 8601 string.
  const iso = toIsoOrNull("Mon, 1 Jan 100000 00:00:00 +0000");
  assert.equal(iso, "+100000-01-01T00:00:00.000Z");
  assert.ok(Number.isFinite(Date.parse(iso)), "must remain re-parsable");
});

test("toIsoOrNull returns null instead of throwing on bad input", () => {
  for (const bad of [
    "", //                            empty Date: header
    "   ", //                         whitespace-only header
    "garbage", //                     unparsable
    "Fri, 32 Zzz 2099 99:99:99", //   nonsense day/month/time
    "Mon, 1 Jan 300000 00:00:00 +0000", // far-future spam header, past year 275760
    new Date("nope"), //              an Invalid Date object
    new Date(8.64e15 + 1), //         out of the representable range
    null,
    undefined,
    {},
    [],
    true,
  ]) {
    assert.doesNotThrow(() => toIsoOrNull(bad), `threw on ${String(bad)}`);
    assert.equal(toIsoOrNull(bad), null, `expected null for ${String(bad)}`);
  }
});

test("safeMessageDate falls back to INTERNALDATE, then to null", () => {
  // Header wins when valid.
  assert.equal(safeMessageDate(GOOD_DATE, INTERNAL), GOOD_DATE.toISOString());
  // Broken header -> server receive time.
  assert.equal(safeMessageDate("garbage", INTERNAL), INTERNAL.toISOString());
  // Nothing usable at all -> null, still no throw.
  assert.equal(safeMessageDate("garbage", new Date("nope")), null);
  assert.equal(safeMessageDate(undefined, undefined), null);
});

test("summarize does not throw on a malformed Date: header", () => {
  const msg = fakeMessage({ uid: 42, envelopeDate: "garbage" });
  let out;
  assert.doesNotThrow(() => {
    out = summarize(msg);
  });
  assert.equal(out.date, null);
  // The message stays addressable so it can still be read or moved.
  assert.equal(out.uid, 42);
  assert.equal(out.subject, "s");
});

test("summarize falls back to INTERNALDATE when the header is unusable", () => {
  const out = summarize(
    fakeMessage({ uid: 7, envelopeDate: "Fri, 32 Zzz 2099 99:99:99", internalDate: INTERNAL })
  );
  assert.equal(out.date, INTERNAL.toISOString());
});

test("one corrupt message no longer hides the rest of the mailbox", () => {
  const mailbox = [
    fakeMessage({ uid: 1, envelopeDate: GOOD_DATE, subject: "ok" }),
    fakeMessage({ uid: 2, envelopeDate: "", subject: "empty date header" }),
    fakeMessage({ uid: 3, envelopeDate: "garbage", subject: "unparsable" }),
    fakeMessage({
      uid: 4,
      envelopeDate: "Fri, 32 Zzz 2099 99:99:99",
      subject: "spam far future",
    }),
    fakeMessage({
      uid: 5,
      envelopeDate: "garbage",
      internalDate: INTERNAL,
      subject: "unparsable but received",
    }),
  ];

  let listed;
  assert.doesNotThrow(() => {
    listed = mailbox.map(summarize);
  }, "building the listing must never throw");

  // Every message comes back — this is the actual bug being fixed.
  assert.equal(listed.length, 5);
  assert.deepEqual(
    listed.map((m) => m.uid),
    [1, 2, 3, 4, 5]
  );

  assert.equal(listed[0].date, GOOD_DATE.toISOString());
  assert.equal(listed[1].date, null);
  assert.equal(listed[2].date, null);
  assert.equal(listed[3].date, null);
  assert.equal(listed[4].date, INTERNAL.toISOString()); // INTERNALDATE fallback

  // The public contract holds: `date` is an ISO string or null, nothing else.
  for (const m of listed) {
    assert.ok(
      m.date === null || !Number.isNaN(Date.parse(m.date)),
      `date must be ISO or null, got ${JSON.stringify(m.date)}`
    );
  }

  // And the whole payload still serialises, which is what the MCP tool does.
  assert.doesNotThrow(() => JSON.stringify(listed));
});

test("compareByDateDesc sorts newest first and parks null dates at the end", () => {
  const rows = [
    { uid: 1, date: null },
    { uid: 2, date: "2026-08-01T10:00:00.000Z" },
    { uid: 3, date: null },
    { uid: 4, date: "2026-08-03T10:00:00.000Z" },
    { uid: 5, date: "2026-08-02T10:00:00.000Z" },
  ];
  let sorted;
  assert.doesNotThrow(() => {
    sorted = [...rows].sort(compareByDateDesc);
  });
  assert.deepEqual(
    sorted.map((r) => r.uid),
    [4, 5, 2, 1, 3]
  );
});
