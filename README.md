# agentpit

**Run many Claude Code agents in parallel from one web cockpit – on your own machine, controlled from any device.**

```bash
npx agentpit
```

One command starts a local web app. Every project gets its own Claude Code session, its own folder and git repository, and – if you want – its own real browser with persistent logins. You watch every command and output live, approve what needs approval, and steer everything from your laptop or phone.

[Deutsche Anleitung](https://unpkg.com/agentpit/README.de.md)

## What you get

- **Unlimited private sessions in parallel.** As many projects as you like, each with its own Claude Code session (official Claude Agent SDK). Sessions stay on your machine; nothing goes to a third-party server except the model calls themselves.
- **AI browser use with persistent identities.** Each browser identity is its own Chromium/Chrome/Edge profile with separate cookies and logins that survive restarts. Claude drives it through Playwright MCP while you watch a live stream and can take over mouse and keyboard at any time – for 2FA, captchas or just to help. One session can switch between several identities mid-task (read with account A, post with account B).
- **Remote from anywhere.** Password-protected, built to sit behind Tailscale, Cloudflare Tunnel or any HTTPS reverse proxy. The UI works on phones, including the remote browser view with touch and on-screen keyboard. Adaptive stream quality keeps lag low on mobile connections.
- **Workflows and sub-agents.** Claude can start and steer other sessions (`session_create`, `session_send`, `session_wait` …), schedule prompts (once, every n minutes, cron) and hand work over through a shared folder. Example: research → cut clips → publish from several accounts, each step its own session.
- **Access gate that works in auto mode.** Anything outside the project – another project's database or session, an unlinked browser identity – asks you first, even when the session runs fully autonomously. "Always allow" is remembered per project and revocable.
- **Per-answer limits.** Cap each answer by cost, share of your 5-hour plan limit, time or number of steps; the answer is stopped when one is hit.
- **Databases and charts.** SQLite, PostgreSQL and MySQL connections with schema browser and query console; Claude can create SQLite databases itself and turn query results into accessible bar, line, area and scatter charts (light and dark).
- **Microservices.** Start dev servers and scripts per project with live logs, health checks, restart policy, ports and dependencies – one overview across all projects. Services can post prompts back into their session through a hook URL.
- **Context that is never lost.** Every prompt, answer and summary is written to `context/` in the project; the context is compacted automatically at a threshold you choose.
- **Usage forecast.** Plan limits (5 h, weekly, per model), cost per session and a preview of what the next prompt will cost.
- **Files, git and GitHub.** File tree with preview (video, image, PDF, HTML), auto-commit after each task, diff, revert, push/pull and one-click "publish to GitHub".
- **Titles write themselves.** Claude Haiku names projects and sessions from your prompts.

Interface language: German.

## Requirements

- Node.js **22.13 or newer** (24 LTS recommended)
- A Claude login (Pro/Max subscription via the built-in login) or `ANTHROPIC_API_KEY`
- Optional: git, ffmpeg (video), GitHub CLI – missing tools show a one-click install button (winget on Windows, Homebrew on macOS)
- Browser identities use installed Chrome/Edge, or download Chromium with `npx agentpit install-browser`

Runs on Windows, macOS and Linux (x64 and arm64, including Jetson boards).

## Usage

```bash
npx agentpit                      # start and open the browser
npx agentpit --port 8080 --no-open
npx agentpit link                 # print the login link and setup code (headless servers)
npx agentpit set-password         # reset the password
npx agentpit install-browser      # Chromium + ffmpeg for browser identities
```

On first start you set a password in the browser. Data, projects and settings live in `~/.agentpit` (change with `--home <dir>` or `AGENTPIT_HOME`). Settings go into `~/.agentpit/.env` – see `.env.example` in the package for all options (runner limits, permission mode default, cleanup, auto-compaction …).

Install permanently instead of `npx`:

```bash
npm i -g agentpit && agentpit
```

## Remote access

The server only listens on `127.0.0.1`. To reach it from other devices, put a tunnel or HTTPS proxy in front of it on the same machine and pass its address:

```bash
tailscale serve --bg 4317           # private, only your devices
npx agentpit --public-url https://my-box.tailnet-1234.ts.net
```

Cloudflare Tunnel, devtunnel or nginx work the same way (the tunnel must pass WebSockets). File previews use a second origin on port + 1 so that generated HTML can never reach the cockpit's session.

## Security

Whoever can open the cockpit can run commands on the machine – that is the point of it. So:

- a password is required from the first start (sessions stored hashed, rate-limited logins, origin checks, DNS-rebinding protection);
- "bypass permissions" mode is locked unless you set `ALLOW_BYPASS_PERMISSIONS=true`;
- browser logins, passwords and 2FA are always done by you, never handed to Claude;
- database passwords are stored in plain text in the data folder – keep `~/.agentpit` private.

Automated logins and scraping can violate the terms of the sites you use. agentpit is an interface for **your own** Claude Code with **your own** account; if you offer it to others, switch to an API key.

## License

MIT. Not affiliated with Anthropic. Claude is a trademark of Anthropic.
