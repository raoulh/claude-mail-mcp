/**
 * Startup self-identification, so an operator can tell at a glance whether the
 * process actually runs the build they just produced.
 *
 * `dist/` is gitignored, so a deploy that pulls without rebuilding — or a
 * process that was never restarted — keeps serving the previous compiled code
 * while the working tree looks perfectly up to date. That failure mode is
 * indistinguishable from "the fix does not work" unless the running process
 * says something about itself.
 *
 * Beyond identifying the artefact, `dateGuard` is a live end-to-end probe of
 * the exact code path that used to throw `RangeError: Invalid time value`:
 * it pushes a real-world malformed `Date:` header through `summarize()` at
 * boot. "safe" proves the fixed code is loaded; "MISSING" proves it is not.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { FetchMessageObject } from "imapflow";
import { summarize } from "./imap-client.js";

/**
 * Verbatim `Date:` header of a spam message that took down whole mailboxes.
 * Node parses it to `Invalid Date`, so imapflow hands back the raw string.
 */
const MALFORMED_DATE_HEADER = "Tue, 11 Aug 2026 09:02:34 GMT 00:00:0 -0000 (UTC) ";

export interface BuildStamp {
  version: string;
  /** Modification time of the compiled imap-client module actually loaded. */
  builtAt: string | null;
  /** Short content hash of that module — changes whenever the code changes. */
  hash: string | null;
  /** Live probe of the malformed-date path: "safe" | "unguarded" | "MISSING". */
  dateGuard: string;
}

function artefact(): { builtAt: string | null; hash: string | null } {
  try {
    const path = new URL("./imap-client.js", import.meta.url);
    const bytes = readFileSync(path);
    return {
      builtAt: statSync(path).mtime.toISOString(),
      hash: createHash("sha256").update(bytes).digest("hex").slice(0, 12),
    };
  } catch {
    // Running from source (tsx) rather than dist/ — not an error.
    return { builtAt: null, hash: null };
  }
}

function probeDateGuard(): string {
  const probe = {
    uid: 0,
    seq: 0,
    flags: new Set<string>(),
    envelope: { date: MALFORMED_DATE_HEADER },
  } as unknown as FetchMessageObject;
  try {
    // `date` must come back null: the header is unparsable and the probe
    // carries no INTERNALDATE to fall back to.
    return summarize(probe).date === null ? "safe" : "unguarded";
  } catch {
    return "MISSING";
  }
}

export function buildStamp(version: string): BuildStamp {
  return { version, ...artefact(), dateGuard: probeDateGuard() };
}
