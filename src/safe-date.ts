/**
 * Defensive date formatting for IMAP message metadata.
 *
 * Spam and broken mailers routinely emit `Date:` headers that are empty,
 * unparsable, or absurdly far in the future. imapflow does not normalise those:
 * `parseEnvelope()` only assigns a `Date` object when the header parses, and
 * otherwise falls back to the **raw header string** — while its TypeScript
 * typings still declare `envelope.date` as `Date`. Calling
 * `new Date(envelope.date).toISOString()` on such a value therefore throws
 * `RangeError: Invalid time value`, and because message summaries are built in a
 * loop a single bad header used to abort an entire mailbox listing.
 *
 * Nothing exported from this module ever throws.
 */

/**
 * Coerce an envelope/INTERNALDATE value into an ISO 8601 string.
 *
 * Accepts a `Date`, a string, or a numeric epoch — i.e. every shape imapflow
 * can hand back. Returns `null` for anything that does not resolve to a valid
 * time value instead of throwing.
 */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    d = new Date(trimmed);
  } else if (typeof value === "number") {
    d = new Date(value);
  } else {
    return null;
  }

  // `Invalid Date` and out-of-range dates (year > 275760, common in spoofed
  // "far future" spam headers) both yield NaN here.
  if (!Number.isFinite(d.getTime())) return null;

  try {
    return d.toISOString();
  } catch {
    return null;
  }
}

/**
 * Resolve the date reported for a message, in order of preference:
 *   1. the message's `Date:` header (envelope date), when it parses;
 *   2. the IMAP INTERNALDATE (server receive time), when available;
 *   3. `null`.
 */
export function safeMessageDate(
  headerDate: unknown,
  internalDate?: unknown
): string | null {
  return toIsoOrNull(headerDate) ?? toIsoOrNull(internalDate);
}
