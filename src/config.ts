/**
 * Environment configuration loader.
 *
 * Reads required variables from process.env, validates them, and exposes a
 * single typed `config` object for the rest of the codebase.
 *
 * CalDAV is optional — if CALDAV_URL is unset the calendar tools are not
 * registered. The mail half of the server still works.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }
  return parsed;
}

const caldavUrl = process.env.CALDAV_URL?.trim() ?? "";

export const config = {
  port: int("PORT", 3220),
  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",

  imap: {
    host: required("IMAP_HOST"),
    port: int("IMAP_PORT", 993),
    user: required("IMAP_USER"),
    pass: required("IMAP_PASS"),
    tls: bool("IMAP_TLS", true),
  },

  smtp: {
    host: required("SMTP_HOST"),
    port: int("SMTP_PORT", 465),
    user: required("SMTP_USER"),
    pass: required("SMTP_PASS"),
    tls: bool("SMTP_TLS", true),
  },

  mail: {
    defaultFrom: required("DEFAULT_FROM"),
    defaultFromName: optional("DEFAULT_FROM_NAME", ""),
    draftsFolder: optional("DRAFTS_FOLDER", "Drafts"),
    // Empty string disables the sent-copy step.
    sentFolder: optional("SENT_FOLDER", "Sent"),
  },

  /**
   * CalDAV config. If `enabled` is false, the calendar tools are not
   * registered and the server starts mail-only.
   */
  caldav: caldavUrl
    ? {
        enabled: true as const,
        url: caldavUrl,
        user: required("CALDAV_USER"),
        pass: required("CALDAV_PASS"),
      }
    : {
        enabled: false as const,
      },

  /**
   * Bearer token a client must present in the Authorization header when
   * calling /mcp. In v0.1 (single-tenant), this is a single shared secret.
   */
  authToken: required("AUTH_TOKEN"),
  publicUrl: optional("PUBLIC_URL", "http://localhost:3220"),
} as const;

export type Config = typeof config;
