#!/usr/bin/env node
/**
 * claude-mail-mcp — entry point.
 *
 * Boots an Express server that exposes:
 *   - GET  /health        liveness probe
 *   - POST /mcp           MCP Streamable HTTP transport (Bearer-auth gated)
 *
 * v0.1 single-tenant: one IMAP/SMTP/CalDAV credential set per deployment,
 * one shared Bearer auth token.
 */

import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.js";
import { ImapClient } from "./imap-client.js";
import { SmtpClient } from "./smtp-client.js";
import { CalDavClient } from "./caldav-client.js";
import { registerMailTools } from "./tools-mail.js";
import { registerCalendarTools } from "./tools-calendar.js";

const VERSION = "0.1.0";

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  };
  // stderr keeps stdout clean for the (unused) stdio transport
  console.error(JSON.stringify(line));
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1] !== config.authToken) {
    log("warn", "rejected unauthenticated MCP request", {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({
      error: "unauthorized",
      message: "Missing or invalid Bearer token",
    });
    return;
  }
  next();
}

async function main(): Promise<void> {
  const imap = new ImapClient({
    host: config.imap.host,
    port: config.imap.port,
    user: config.imap.user,
    pass: config.imap.pass,
    secure: config.imap.tls,
  });

  const smtp = new SmtpClient(
    {
      host: config.smtp.host,
      port: config.smtp.port,
      user: config.smtp.user,
      pass: config.smtp.pass,
      secure: config.smtp.tls,
    },
    {
      from: config.mail.defaultFrom,
      fromName: config.mail.defaultFromName || undefined,
    }
  );

  const caldav = config.caldav.enabled
    ? new CalDavClient({
        url: config.caldav.url,
        user: config.caldav.user,
        pass: config.caldav.pass,
      })
    : null;

  const mcp = new McpServer({
    name: "claude-mail-mcp",
    version: VERSION,
  });
  registerMailTools(mcp, imap, smtp, {
    draftsFolder: config.mail.draftsFolder,
    sentFolder: config.mail.sentFolder || null,
  });
  if (caldav) {
    registerCalendarTools(mcp, caldav);
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "claude-mail-mcp",
      version: VERSION,
      imap_host: config.imap.host,
      smtp_host: config.smtp.host,
      caldav_enabled: config.caldav.enabled,
    });
  });

  app.post("/mcp", bearerAuth, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error", "MCP request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `${req.method} ${req.path} is not a valid endpoint. Use GET /health or POST /mcp.`,
    });
  });

  app.listen(config.port, () => {
    log("info", "claude-mail-mcp listening", {
      port: config.port,
      version: VERSION,
      public_url: config.publicUrl,
      imap_host: config.imap.host,
      smtp_host: config.smtp.host,
      caldav_enabled: config.caldav.enabled,
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("info", "shutting down", { signal });
    await imap.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
