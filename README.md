<p align="center">
  <img src="public/icon.png" width="128" alt="mail-mcp icon">
</p>

<h1 align="center">mail-mcp</h1>

<p align="center">Connect Claude, ChatGPT or any MCP client to your own mail server. Signs in with your server's login, works over JMAP.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/jessekhach/mail-mcp" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/tested%20with-Stalwart%201.1-blue" alt="Tested with Stalwart 1.1">
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjessekhach%2Fmail-mcp&env=JMAP_SESSION_URL&envDescription=Your%20mail%20server%27s%20JMAP%20session%20URL%2C%20like%20https%3A%2F%2Fmail.example.com%2Fjmap%2Fsession&project-name=mail-mcp"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
</p>

---

I moved my email from Fastmail to [Stalwart](https://stalw.art) on a Mac mini at home and missed having Claude in my inbox, so I wrote this.

You deploy your own copy (free on Vercel's Hobby plan), point it at your server, and add it to Claude or any other MCP client that supports OAuth. When you connect, you sign in on your mail server's own login page. The connector never sees your password and stores nothing.

## Tools

| Tool | What it does |
|---|---|
| `list_mailboxes` | Folders with their roles and counts |
| `list_identities` | Addresses you can send from |
| `search_emails` | Full-text search plus from, to, subject, date, folder, unread, flagged and attachment filters |
| `get_email` | One message: headers, body as text, attachment names |
| `get_thread` | A whole conversation |
| `send_email` | New message, from any of your identities. Bcc stays out of the headers |
| `save_draft` | Saves to Drafts so you can finish it in any mail app |
| `reply_to_email` | Replies in the same thread, from the address the original was sent to. Can save as a draft instead |
| `move_emails` | Moves to a folder (archive, junk, any name) |
| `update_emails` | Marks read, unread, flagged |
| `delete_emails` | Moves to Trash, or deletes permanently if asked |

## Setup

You need a JMAP mail server with OAuth. I've only tested Stalwart 1.1.

**1. Let the connector sign in to your server.** The connector identifies itself to your server with a client metadata document (a URL instead of a pre-registered app), and Stalwart turns those off by default. Set the OpenID Connect provider's client metadata documents option to `any`. Any app can then ask to sign in, but it still needs your password and your approval on the consent screen.

**2. Deploy.** Click Deploy with Vercel above and set `JMAP_SESSION_URL` to your server's session URL, for example `https://mail.example.com/jmap/session`. That's the only setting.

**3. Add it to your AI app** with the URL `https://<your-deployment>/mcp`, then sign in on your mail server and approve "mail-mcp". Stalwart labels it unverified because it's your own deployment, not a registered app.

- **Claude:** Settings > Connectors > Add custom connector. Connectors added on claude.ai also show up in the Claude desktop and mobile apps and in Claude Code, as long as you're signed in to the same account.
- **ChatGPT:** custom MCP connectors need Developer Mode (Settings > Apps & Connectors > Advanced), which depends on your plan. I haven't tested ChatGPT yet.
- **Anything else** (Cursor, VS Code and so on): add it as a remote MCP server with OAuth. Untested, but it's standard MCP OAuth with dynamic client registration and client metadata documents.

**Docker instead of Vercel:**

```bash
git clone https://github.com/jessekhach/mail-mcp && cd mail-mcp
docker build -t mail-mcp .
docker run -d --restart unless-stopped -p 3000:3000 \
  -e JMAP_SESSION_URL=https://mail.example.com/jmap/session mail-mcp
```

Your AI app has to reach it over HTTPS, so put it behind a reverse proxy that sets `X-Forwarded-Host` and `X-Forwarded-Proto` (Caddy does by default). The connector builds its sign-in URLs from those headers.

## How it works

```
Sign in:  app -> /oauth/authorize -> your server's login -> /oauth/callback -> app
          app -> /oauth/token -> your server's token endpoint
Use:      app --(your server's access token)--> /mcp --(JMAP)--> your server
```

My first version pointed Claude straight at Stalwart's OAuth, and it never got past sign-in. Claude asks for every scope the server advertises (admin ones included), and asks for a token for the connector's URL, which the server won't issue. So the connector is its own small OAuth server in front of yours:

- `/oauth/authorize` sends you to your server's login with the connector's own client ID and only the mail scope (`urn:ietf:params:oauth:scope:mail`, plus `offline_access` so Claude stays connected).
- The app's PKCE challenge is passed through unchanged, so your mail server does the PKCE check itself.
- The tokens the app gets back are your server's own access and refresh tokens. Each `/mcp` request is checked by asking your server for the JMAP session with that token, so there's no database and no secret to configure.

## Privacy and security

- Nothing is stored. No passwords, no tokens, no mail. Each request carries your server's token and the connector forwards it.
- Claude, ChatGPT and apps on your own computer go straight to your server's login. Any other app first gets a page on the connector that names where the sign-in will go ("vscode.dev wants to read, send and delete your email"). Without it, anyone could send you a sign-in link that hands your mail to their server, and your mail server's consent screen would only say "mail-mcp".
- Each sign-in is tied to the browser that started it with a short-lived cookie, so a login link built by someone else fails at the callback.
- The connector only asks your server for the mail scope, never admin, settings, contacts or calendars.
- The tools can send and delete mail. An email can contain text written to steer an AI, so if that worries you, keep `send_email` and `delete_emails` on "ask" in your app's tool permissions.
- Your deployment only talks to the one server in `JMAP_SESSION_URL`.

## Limitations

- JMAP only. No IMAP or SMTP.
- Mail only for now: no calendars or contacts, no sending attachments.
- Tested with Stalwart 1.1. Other JMAP servers need OAuth with RFC 8414 metadata at the server's root and client metadata document support.

## Project structure

```
app/mcp/route.ts           MCP endpoint, checks the token against your server
app/oauth/*                authorize, callback, token, register, client.json
app/.well-known/*          OAuth discovery documents
lib/tools.ts               the tools
lib/jmap.ts                small JMAP client
lib/oauth.ts               callback rules, state and upstream discovery
lib/consent.ts             the page shown before signing in for an unknown app
scripts/make-icon.swift    draws the icon (swift scripts/make-icon.swift)
Dockerfile                 standalone image, about 300 MB
```

## License

[MIT](LICENSE)
