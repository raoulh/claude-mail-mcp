# claude-mail-mcp

Self-hosted **IMAP / SMTP / CalDAV connector for Claude**. A Streamable HTTP MCP server that lets [Claude.ai](https://claude.ai) read and write your email + calendar against any RFC-compliant mailbox.

> Built because every other Claude email connector targets Gmail. This one is for the rest of us — Mailbox.org, Fastmail, iCloud, Mailcow, iRedMail, Migadu, Nextcloud, your own Postfix box. If your provider speaks IMAP, SMTP and CalDAV, this works.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E=20-brightgreen.svg)](https://nodejs.org)

---

## What it does

Exposes 13 MCP tools to Claude:

**Mail (9)**

| Tool | Purpose |
|------|---------|
| `list_folders` | Enumerate IMAP mailboxes (`INBOX`, `Sent`, …) |
| `list_messages` | Newest N messages in a folder |
| `search_messages` | Server-side IMAP search (from/to/subject/body/date/flags) |
| `get_message` | Full body + headers + attachment metadata |
| `send_message` | Send via SMTP, optionally copy to Sent folder |
| `create_draft` | Build RFC-822 and APPEND to Drafts |
| `mark_read` | Toggle `\Seen` flag |
| `move_message` | Move between folders |
| `delete_message` | Delete (destructive — prefer move to Trash) |

**Calendar (4, only if `CALDAV_URL` is set)**

| Tool | Purpose |
|------|---------|
| `list_calendars` | Discover CalDAV calendars |
| `list_events` | Events in a time window (recurrences expanded) |
| `create_event` | Add new event (writes to CalDAV) |
| `find_free_slot` | Compute free intervals across one or more calendars |

---

## Why bring-your-own-server?

Hosted email-AI services need full mailbox access. That's a lot of trust to hand to a vendor. This connector flips the model: **you run it, you hold the credentials, no third party between Claude and your inbox**.

- One Node process per mailbox
- Credentials in a single `.env` file
- One Bearer token gates every MCP call
- Add the URL to Claude.ai once, done

---

## Quick start

```bash
git clone https://github.com/maxx3250/claude-mail-mcp.git
cd claude-mail-mcp
npm install
cp .env.example .env
# Fill in IMAP_*, SMTP_*, DEFAULT_FROM, AUTH_TOKEN (and CALDAV_* if you want calendar)
npm run build
npm start
```

Smoke test:

```bash
curl http://localhost:3220/health
# {"status":"ok","server":"claude-mail-mcp",…,"caldav_enabled":true}
```

---

## Connecting from Claude.ai

The server speaks the **Streamable HTTP MCP transport**. To use it from Claude.ai (web), you need an OAuth 2.1 + DCR + PKCE layer in front because Claude.ai does not support raw Bearer auth.

The recommended setup mirrors what [claude-meta-mcp](https://github.com/maxx3250/claude-meta-mcp) uses:

1. Terminate TLS with nginx / Caddy on a public hostname (e.g. `mcp-mail.yourdomain.com`)
2. Put a tiny **OAuth shim** in front that issues short-lived Bearer tokens after a basic-auth login
3. Add the public URL as a Custom Connector in Claude.ai (Settings → Connectors → Add custom)

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full nginx + systemd + shim recipe.

For local testing without a shim, you can call `/mcp` directly with `Authorization: Bearer <AUTH_TOKEN>` from any MCP client that supports custom headers (Claude Desktop config, or a stdio bridge).

---

## Provider notes

### App passwords (mandatory on 2FA accounts)

| Provider | IMAP host | SMTP host | App password page |
|----------|-----------|-----------|---------------------|
| Mailbox.org | `imap.mailbox.org:993` | `smtp.mailbox.org:465` | App passwords aren't needed; main password works |
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:465` | <https://app.fastmail.com/settings/security/devicekeys> |
| iCloud | `imap.mail.me.com:993` | `smtp.mail.me.com:587` (STARTTLS) | <https://appleid.apple.com> → App-Specific Passwords |
| Gmail | `imap.gmail.com:993` | `smtp.gmail.com:465` | <https://myaccount.google.com/apppasswords> |
| Mailcow / iRedMail / Postfix | your server | your server | n/a |

### CalDAV endpoints

| Provider | URL |
|----------|-----|
| Fastmail | `https://caldav.fastmail.com/dav/principals/user/USER@fastmail.com/` |
| Mailbox.org | `https://dav.mailbox.org/caldav/` |
| iCloud | `https://caldav.icloud.com/` |
| Nextcloud | `https://cloud.example.com/remote.php/dav/principals/users/USER/` |

If your provider doesn't speak CalDAV, leave `CALDAV_URL` empty and the calendar tools won't be registered. Mail still works.

---

## Architecture

```
Claude.ai (web)
    │  HTTPS + OAuth 2.1
    ▼
nginx (TLS, /health passthrough)
    │
    ├──▶ /mcp/* ─▶ OAuth shim (Port 3212)  ──▶ Bearer ──▶ this server (Port 3220)
    └──▶ /health ────────────────────────────────────────▶ this server (Port 3220)

this server
    ├── ImapClient   ──▶  imapflow  ──▶  IMAP server (993/143)
    ├── SmtpClient   ──▶  nodemailer ─▶  SMTP server (465/587)
    └── CalDavClient ──▶  tsdav     ──▶  CalDAV server
```

Everything is one Node process. IMAP holds a single long-lived connection with per-call mailbox locks. SMTP and CalDAV are stateless per call.

---

## Security model

- **One deployment = one mailbox.** No multi-tenant state in v0.1.
- **Bearer token** in `Authorization: Bearer <AUTH_TOKEN>` gates every `/mcp` call.
- **TLS termination** is expected upstream — bind only to localhost in production.
- **Destructive tools** (`delete_message`) document the irreversibility in their description so Claude.ai surfaces a confirmation step in the UI. Prefer `move_message` to a Trash folder for reversibility.
- **Credentials** never leave `.env`. They are never logged or returned to the client.

Reporting issues: see [SECURITY.md](SECURITY.md).

---

## Roadmap

- **v0.2** — Multi-tenant: SQLite-backed token store, per-user IMAP/SMTP credentials, OAuth flow that asks the user for their server settings
- **v0.3** — Threading-aware `list_threads` tool, attachment download, calendar invitation (iMIP) sending
- **v0.4** — CardDAV (contacts), JMAP support as an alternative to IMAP for Fastmail/Topicbox
- **v1.0** — Audit log, Prometheus metrics, rate limiting, hardened deployment guide

---

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- [imapflow](https://imapflow.com/) — modern Promise-based IMAP client
- [nodemailer](https://nodemailer.com/) — the only Node SMTP client worth using
- [tsdav](https://github.com/natelindev/tsdav) — clean TypeScript WebDAV/CalDAV/CardDAV
- [ical.js](https://github.com/kewisch/ical.js) — battle-tested iCalendar parser
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — Anthropic's official MCP SDK
