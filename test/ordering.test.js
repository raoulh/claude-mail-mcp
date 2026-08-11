/**
 * Regression tests for the "newest first" ordering contract.
 *
 * list_messages and search_messages both advertise "newest first". The
 * sequence-number path honoured that, but the two paths that fetch an explicit
 * UID set reversed the *UID list* before joining it into the fetch command —
 * and an IMAP server is free to emit untagged FETCH responses in its own order
 * (in practice ascending sequence order) regardless of the order requested. The
 * reverse() was therefore discarded and those paths returned oldest-first.
 *
 * Run against the compiled output: `npm test` builds first.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ImapClient, sortNewestFirst } from "../dist/imap-client.js";

/** Envelope-shaped fetch record, as imapflow yields it. */
function fakeMessage(uid) {
  return {
    uid,
    seq: uid,
    flags: new Set(),
    size: 100,
    internalDate: new Date(Date.UTC(2026, 0, uid)),
    envelope: {
      date: new Date(Date.UTC(2026, 0, uid)),
      subject: `msg ${uid}`,
      from: [{ address: "a@example.com" }],
    },
  };
}

/** Does `uid` fall inside an IMAP sequence set such as "3", "5,9" or "11:*"? */
function inRange(uid, range) {
  return String(range)
    .split(",")
    .some((part) => {
      if (!part.includes(":")) return Number(part) === uid;
      const [lo, hi] = part.split(":");
      return uid >= Number(lo) && (hi === "*" || uid <= Number(hi));
    });
}

/**
 * Stand-in for ImapFlow that mimics the behaviour at the heart of the bug:
 * whatever order the sequence set is given in, responses come back ascending.
 */
function fakeImapFlow({ uids, total }) {
  return {
    requestedRanges: [],
    async getMailboxLock() {
      return { release() {} };
    },
    async status() {
      return { messages: total ?? uids.length };
    },
    async search() {
      return [...uids].sort((a, b) => a - b); // servers answer ascending
    },
    fetch(range) {
      this.requestedRanges.push(range);
      // Honour *which* messages were asked for, but deliberately ignore the
      // order they were asked in — exactly like a real IMAP server.
      const selected = uids.filter((uid) => inRange(uid, range));
      const ascending = selected.sort((a, b) => a - b);
      return (async function* () {
        for (const uid of ascending) yield fakeMessage(uid);
      })();
    },
  };
}

/** Build an ImapClient whose connection is replaced by the fake above. */
function clientWith(fake) {
  const c = new ImapClient({
    host: "localhost",
    port: 993,
    secure: true,
    user: "u",
    pass: "p",
  });
  // `private` is erased at runtime; shadow the method on the instance.
  c.ensureConnected = async () => fake;
  return c;
}

test("sortNewestFirst orders by descending UID", () => {
  const sorted = sortNewestFirst([
    { uid: 3 },
    { uid: 10 },
    { uid: 1 },
    { uid: 7 },
  ]);
  assert.deepEqual(
    sorted.map((m) => m.uid),
    [10, 7, 3, 1]
  );
});

test("sortNewestFirst parks entries without a usable UID at the end", () => {
  let sorted;
  assert.doesNotThrow(() => {
    sorted = sortNewestFirst([
      { uid: undefined },
      { uid: 5 },
      { uid: NaN },
      { uid: 9 },
    ]);
  });
  assert.deepEqual(
    sorted.slice(0, 2).map((m) => m.uid),
    [9, 5]
  );
  assert.equal(sorted.length, 4);
});

test("sortNewestFirst does not mutate its input", () => {
  const input = [{ uid: 1 }, { uid: 2 }];
  sortNewestFirst(input);
  assert.deepEqual(
    input.map((m) => m.uid),
    [1, 2]
  );
});

test("list_messages returns newest first (sequence path)", async () => {
  const fake = fakeImapFlow({ uids: [11, 12, 13, 14], total: 14 });
  const out = await clientWith(fake).listMessages("INBOX", { limit: 4 });
  assert.deepEqual(
    out.map((m) => m.uid),
    [14, 13, 12, 11]
  );
});

test("list_messages unread_only returns newest first", async () => {
  // This is the regression: the server replies ascending, so the old
  // uids.reverse() before join() had no effect on the result order.
  const fake = fakeImapFlow({ uids: [2, 5, 9], total: 20 });
  const out = await clientWith(fake).listMessages("INBOX", {
    limit: 25,
    unreadOnly: true,
  });
  assert.deepEqual(
    out.map((m) => m.uid),
    [9, 5, 2],
    "unread_only must not return oldest-first"
  );
});

test("search_messages returns newest first", async () => {
  const fake = fakeImapFlow({ uids: [4, 8, 15, 16], total: 20 });
  const out = await clientWith(fake).searchMessages("INBOX", { from: "a@" }, 25);
  assert.deepEqual(
    out.map((m) => m.uid),
    [16, 15, 8, 4],
    "search must not return oldest-first"
  );
});

test("the limit still selects the newest UIDs, not the oldest", async () => {
  const fake = fakeImapFlow({ uids: [1, 2, 3, 4, 5, 6, 7, 8], total: 20 });
  const out = await clientWith(fake).searchMessages("INBOX", { from: "a@" }, 3);
  // slice(-3) keeps 6,7,8 — the newest three — and they come back descending.
  assert.deepEqual(
    fake.requestedRanges.at(-1).split(",").map(Number).sort((a, b) => a - b),
    [6, 7, 8]
  );
  assert.deepEqual(
    out.map((m) => m.uid),
    [8, 7, 6]
  );
});
