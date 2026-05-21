# Deployment

A typical production deployment behind nginx with pm2 as the process manager. Adapt to your stack as needed.

## Requirements

- Node.js ≥ 20
- A public DNS name pointing at your server (HTTPS is required by Claude.ai)
- An IMAP + SMTP capable mailbox
- Optionally a CalDAV endpoint

## 1. Clone and build

```bash
cd /var/www
git clone https://github.com/maxx3250/claude-mail-mcp.git mail-mcp
cd mail-mcp
npm ci
npm run build
```

## 2. Configure

```bash
cp .env.example .env
# generate the Bearer token clients will send to /mcp
echo "AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
# edit .env and fill in IMAP_*, SMTP_*, DEFAULT_FROM, PUBLIC_URL, and optionally CALDAV_*
```

For two-factor mailboxes (Gmail, iCloud, Fastmail) use an **app-specific password**, never your main account password. See the table in the [README](../README.md#app-passwords-mandatory-on-2fa-accounts) for direct links.

## 3. Run via pm2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd   # enable on boot
pm2 logs claude-mail-mcp
```

### Alternative: systemd

```ini
[Unit]
Description=claude-mail-mcp
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/mail-mcp
ExecStart=/usr/bin/node --env-file=/var/www/mail-mcp/.env --enable-source-maps /var/www/mail-mcp/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now claude-mail-mcp
```

## 4. Reverse proxy (nginx)

```nginx
server {
    listen 80;
    server_name mcp-mail.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name mcp-mail.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp-mail.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp-mail.example.com/privkey.pem;

    server_tokens off;

    # Streamable HTTP can keep connections open longer than the nginx default
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_buffering    off;

    # Email bodies and attachments can be large
    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3220;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization     $http_authorization;
        proxy_set_header Transfer-Encoding "";
    }
}
```

```bash
certbot --nginx -d mcp-mail.example.com
```

## 5. Add to Claude

### Option A — Claude Desktop (Bearer auth, simplest)

1. Open **Claude Desktop → Settings → Developer → Edit Config**
2. Add an entry:
   ```json
   {
     "mcpServers": {
       "mail": {
         "url": "https://mcp-mail.example.com/mcp",
         "transport": "http",
         "headers": { "Authorization": "Bearer YOUR_AUTH_TOKEN" }
       }
     }
   }
   ```
3. Restart Claude Desktop. The mail and (optionally) calendar tools appear under "mail".

### Option B — claude.ai web (OAuth 2.1 + DCR)

claude.ai will only connect to remote MCP servers that advertise OAuth 2.1 discovery. To support that, run a thin OAuth shim in front of the connector. A reference implementation lives at <https://github.com/markusstoeger/mcp-oauth-shim>.

The shim:
- Implements `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`, `/jwks.json`
- Validates Claude's PKCE flow + DCR registration
- Forwards `/mcp` traffic to the connector with the upstream Bearer header injected
- Authenticates the human in `/authorize` against an htpasswd file

When the shim is in front:

1. claude.ai → **Settings → Connectors → Add custom connector**
2. URL: `https://mcp-mail.example.com/mcp` (the shim's public URL)
3. claude.ai discovers the OAuth endpoints automatically
4. A login popup asks for the htpasswd user/password
5. The tools appear in the connector

## 6. Verify

```bash
# health
curl https://mcp-mail.example.com/health
# → {"status":"ok",…,"caldav_enabled":true}

# unauthenticated request should be rejected
curl -i -X POST https://mcp-mail.example.com/mcp -H 'Content-Type: application/json' -d '{}'
# → HTTP/1.1 401 Unauthorized

# tools/list with auth
curl -X POST https://mcp-mail.example.com/mcp \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → JSON with 9 or 13 tools (depending on whether CALDAV_URL is set)
```

## 7. Updating

```bash
cd /var/www/mail-mcp
git pull
npm ci
npm run build
pm2 reload claude-mail-mcp --update-env
```

## 8. Operational notes

**Credentials.** Rotate `AUTH_TOKEN` periodically. If you use an app-specific password (Gmail, iCloud, Fastmail), revoke it from the provider's UI when the connector is decommissioned.

**Backup.** The service is stateless. Just keep `.env` safe.

**Monitoring.** Hit `/health` from your uptime checker. Alert on non-200 responses or pm2 restart loops. The endpoint also reports `caldav_enabled` so you can detect misconfiguration.

**Connection idle.** The IMAP connection auto-reconnects on demand. If your provider closes idle connections aggressively (some do after 10 minutes), the next tool call simply reopens the socket.
