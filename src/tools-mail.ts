/**
 * Mail tool registry.
 *
 * Eight tools across read (4) and write (4). All return JSON text content
 * so claude.ai can render structured replies. Destructive operations
 * (delete_message) document the irreversibility in their description so
 * claude.ai surfaces a confirmation step in the UI.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ImapClient } from "./imap-client.js";
import { SmtpClient } from "./smtp-client.js";

export interface MailToolOptions {
  draftsFolder: string;
  sentFolder: string | null;
}

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const recipientSchema = z.union([z.string(), z.array(z.string()).min(1)]);

export function registerMailTools(
  server: McpServer,
  imap: ImapClient,
  smtp: SmtpClient,
  opts: MailToolOptions
): void {
  server.registerTool(
    "list_folders",
    {
      description:
        "List all IMAP mailboxes (folders) on the configured account. Returns path, name, flags and special-use attribute (e.g. \\Sent, \\Drafts, \\Trash) — useful for picking the right `mailbox` parameter for other tools.",
      inputSchema: {},
    },
    async () => {
      return asJson(await imap.listMailboxes());
    }
  );

  server.registerTool(
    "list_messages",
    {
      description:
        "List the newest messages in a mailbox (newest first). Returns headers + a short preview, NOT the full body — use get_message for the body.",
      inputSchema: {
        mailbox: z
          .string()
          .describe("IMAP folder path (e.g. 'INBOX', 'Sent', 'Archive/2026')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max messages to return (default 25)"),
        unread_only: z
          .boolean()
          .optional()
          .describe("Return only unread messages"),
      },
    },
    async ({ mailbox, limit, unread_only }) => {
      const list = await imap.listMessages(mailbox, {
        limit,
        unreadOnly: unread_only,
      });
      return asJson({ mailbox, count: list.length, messages: list });
    }
  );

  server.registerTool(
    "search_messages",
    {
      description:
        "Server-side IMAP SEARCH across one mailbox. Combine any criteria (AND-style). Dates must be ISO YYYY-MM-DD. Returns headers + short preview — use get_message for the body.",
      inputSchema: {
        mailbox: z.string().describe("IMAP folder path to search in"),
        from: z.string().optional().describe("Substring match in From: header"),
        to: z.string().optional().describe("Substring match in To: header"),
        subject: z.string().optional().describe("Substring match in Subject:"),
        body: z
          .string()
          .optional()
          .describe("Substring match in the message body"),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Match messages on/after this date (YYYY-MM-DD)"),
        before: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Match messages strictly before this date (YYYY-MM-DD)"),
        unread: z
          .boolean()
          .optional()
          .describe("true = unread only, false = read only"),
        flagged: z
          .boolean()
          .optional()
          .describe("true = flagged only, false = unflagged only"),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ mailbox, limit, ...criteria }) => {
      const list = await imap.searchMessages(mailbox, criteria, limit ?? 25);
      return asJson({ mailbox, count: list.length, messages: list });
    }
  );

  server.registerTool(
    "get_message",
    {
      description:
        "Fetch one message by UID. Returns headers, full text+HTML body, attachment metadata (filenames + content types, NOT raw bytes), and threading IDs (Message-ID, In-Reply-To, References) for replies.",
      inputSchema: {
        mailbox: z.string().describe("IMAP folder the message lives in"),
        uid: z
          .number()
          .int()
          .positive()
          .describe("Message UID as returned by list_messages/search_messages"),
      },
    },
    async ({ mailbox, uid }) => {
      return asJson(await imap.getMessage(mailbox, uid));
    }
  );

  server.registerTool(
    "send_message",
    {
      description:
        "Send an email via SMTP. WRITE OPERATION — the message goes out immediately. Use create_draft instead if you want to review before sending. Saves a copy in the Sent folder if configured. For replies, pass in_reply_to + references from the original get_message result.",
      inputSchema: {
        to: recipientSchema.describe(
          "Recipient(s). String or array of email addresses."
        ),
        subject: z.string().min(1).describe("Subject line"),
        text: z.string().optional().describe("Plain-text body"),
        html: z.string().optional().describe("HTML body"),
        cc: recipientSchema.optional(),
        bcc: recipientSchema.optional(),
        reply_to: z.string().optional().describe("Reply-To header"),
        in_reply_to: z
          .string()
          .optional()
          .describe("Message-ID being replied to (for threading)"),
        references: z
          .array(z.string())
          .optional()
          .describe("References header values (for threading)"),
        attachments: z
          .array(
            z.object({
              filename: z.string(),
              content_base64: z.string(),
              content_type: z.string().optional(),
            })
          )
          .optional(),
      },
    },
    async (args) => {
      if (!args.text && !args.html) {
        throw new Error("Provide at least one of `text` or `html`.");
      }
      const result = await smtp.send({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        replyTo: args.reply_to,
        inReplyTo: args.in_reply_to,
        references: args.references,
        attachments: args.attachments?.map((a) => ({
          filename: a.filename,
          contentBase64: a.content_base64,
          contentType: a.content_type,
        })),
      });
      // Best-effort copy to Sent folder.
      let savedToSent = false;
      if (opts.sentFolder) {
        try {
          const raw = await smtp.buildRawSource({
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject,
            text: args.text,
            html: args.html,
            replyTo: args.reply_to,
            inReplyTo: args.in_reply_to,
            references: args.references,
            attachments: args.attachments?.map((a) => ({
              filename: a.filename,
              contentBase64: a.content_base64,
              contentType: a.content_type,
            })),
          });
          await imap.append(opts.sentFolder, raw, ["\\Seen"]);
          savedToSent = true;
        } catch {
          // Sent-folder copy is best effort; the actual send already succeeded.
        }
      }
      return asJson({ ...result, saved_to_sent: savedToSent });
    }
  );

  server.registerTool(
    "create_draft",
    {
      description:
        "Build an RFC-822 message and APPEND it to the Drafts folder. Does NOT send. Use for compose-and-review flows where the user wants to edit in their mail client before sending.",
      inputSchema: {
        to: recipientSchema,
        subject: z.string().min(1),
        text: z.string().optional(),
        html: z.string().optional(),
        cc: recipientSchema.optional(),
        bcc: recipientSchema.optional(),
        in_reply_to: z.string().optional(),
        references: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      if (!args.text && !args.html) {
        throw new Error("Provide at least one of `text` or `html`.");
      }
      const raw = await smtp.buildRawSource({
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        inReplyTo: args.in_reply_to,
        references: args.references,
      });
      await imap.append(opts.draftsFolder, raw, ["\\Draft", "\\Seen"]);
      return asJson({
        success: true,
        folder: opts.draftsFolder,
        bytes: raw.length,
      });
    }
  );

  server.registerTool(
    "mark_read",
    {
      description:
        "Set or clear the \\Seen flag on a message. WRITE OPERATION but easily reversible.",
      inputSchema: {
        mailbox: z.string(),
        uid: z.number().int().positive(),
        read: z.boolean().describe("true = mark as read, false = mark unread"),
      },
    },
    async ({ mailbox, uid, read }) => {
      await imap.markRead(mailbox, uid, read);
      return asJson({ success: true, mailbox, uid, read });
    }
  );

  server.registerTool(
    "move_message",
    {
      description:
        "Move a message from one mailbox to another (e.g. Inbox → Archive). WRITE OPERATION.",
      inputSchema: {
        source_mailbox: z.string(),
        uid: z.number().int().positive(),
        destination_mailbox: z.string(),
      },
    },
    async ({ source_mailbox, uid, destination_mailbox }) => {
      await imap.moveMessage(source_mailbox, uid, destination_mailbox);
      return asJson({
        success: true,
        from: source_mailbox,
        to: destination_mailbox,
        uid,
      });
    }
  );

  server.registerTool(
    "delete_message",
    {
      description:
        "Delete a message. DESTRUCTIVE — most IMAP servers move it to Trash but some EXPUNGE immediately. Prefer move_message to a Trash folder for reversibility.",
      inputSchema: {
        mailbox: z.string(),
        uid: z.number().int().positive(),
      },
    },
    async ({ mailbox, uid }) => {
      await imap.deleteMessage(mailbox, uid);
      return asJson({ success: true, mailbox, uid });
    }
  );
}
