<h1 align="center">agentpit</h1>

<p align="center"><b>Run many Claude Code agents in parallel from one web cockpit – on your machine, controlled from any device.</b><br>
AI browser automation with real logged-in browsers · sub-agents and scheduled workflows · approvals that work in auto mode</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentpit"><img alt="npm" src="https://img.shields.io/npm/v/agentpit?color=f0a73a&label=npm"></a>
  <a href="https://www.npmjs.com/package/agentpit"><img alt="downloads" src="https://img.shields.io/npm/dm/agentpit?color=2a78d6"></a>
  <img alt="node" src="https://img.shields.io/node/v/agentpit">
  <img alt="platforms" src="https://img.shields.io/badge/runs%20on-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-1baf7a">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/agentpit"></a>
</p>

```bash
npx agentpit
```

![A real session: Claude opens Hacker News in a linked browser identity, finds the top AI story and summarises it – you watch both side by side](https://raw.githubusercontent.com/ManuelWestermeier/agentpit/main/docs/demo.gif)

<sub>Real recording, sped up. [MP4](https://raw.githubusercontent.com/ManuelWestermeier/agentpit/main/docs/demo.mp4) · the prompt was “Open news.ycombinator.com, find the top story about AI and give me a 3-bullet summary.”</sub>

One command starts a local web app. Every project gets its own Claude Code session, folder and git repository – and, if you want, its own **real browser with persistent logins** that Claude drives while you watch and can take over at any moment. Approve, steer and stop everything from your laptop or your phone.

English and German interface (follows your browser) · [Deutsche Anleitung](https://cdn.jsdelivr.net/npm/agentpit@latest/README.de.md)

## Why agentpit

| You want to … | agentpit gives you |
|---|---|
| run 5 agents at once instead of 5 terminal tabs | unlimited parallel sessions, each with its own project, history, cost and context meter |
| let an agent use websites you are logged into | browser identities: separate Chromium/Chrome/Edge profiles with cookies that survive restarts, live view, remote mouse/keyboard |
| check on agents from the couch | password-protected web UI built for Tailscale / Cloudflare Tunnel, phone-friendly, adaptive stream quality |
| chain agents into workflows | sub-sessions (`session_create`, `session_send`, `session_wait`), cron schedules, a shared folder for hand-overs |
| keep autonomy *and* control | auto mode, but anything outside the project (other DBs, sessions, logged-in identities) still asks first |
| not burn your plan | per-answer limits (cost, % of 5-h limit, time, steps), live usage forecast |

## Features

<img align="right" width="260" alt="agentpit on a phone" src="https://cdn.jsdelivr.net/npm/agentpit@latest/docs/phone.jpg">

- **Unlimited private sessions.** Official Claude Agent SDK, one Claude Code process per project, everything stays on your machine.
- **AI browser use with persistent identities.** Playwright MCP over CDP on real browser profiles; one session can switch identities mid-task (read with account A, post with account B). Logins, 2FA and captchas stay with you.
- **Remote from anywhere.** Password, hashed sessions, rate limits, origin and DNS-rebinding checks; generated HTML is served from a separate origin.
- **Workflows and sub-agents.** Sessions start and steer other sessions, schedules send prompts once, every n minutes or by cron.
- **Access gate that works in auto mode.** "Always allow" is remembered per project and revocable.
- **Per-answer limits** by cost, share of the 5-hour plan limit, time or steps.
- **Databases and charts.** SQLite, PostgreSQL, MySQL with schema browser and query console; Claude creates SQLite databases and accessible bar/line/area/scatter charts.
- **Microservices.** Dev servers and scripts with live logs, health checks, restart policy, ports and dependencies, across all projects; services can post prompts back to Claude.
- **Context never lost.** Prompts, answers and summaries are written to `context/`; automatic compaction at your threshold.
- **Files, git, GitHub.** Preview (video, image, PDF, HTML), auto-commit per task, diff, revert, push/pull, one-click private repo.
- **Ready-made workflows.** A new session offers one-click tasks: monitor a website, research → video → post, daily briefing, collect & chart data, build & run an app, triage your inbox.
- **One-click setup.** Missing ffmpeg, git or GitHub CLI? A button installs them (winget / Homebrew).

<br clear="right">

![Claude drives a real, logged-in browser while you watch live](https://cdn.jsdelivr.net/npm/agentpit@latest/docs/browser.jpg)

![Session with approvals, a question from Claude and a finished task](https://cdn.jsdelivr.net/npm/agentpit@latest/docs/session.png)

![Microservices with health checks and live logs](https://cdn.jsdelivr.net/npm/agentpit@latest/docs/microservices.png)

## Quick start

Requirements: **Node.js 22.13+** and a Claude login (Pro/Max via the built-in sign-in) or `ANTHROPIC_API_KEY`. Windows, macOS and Linux (x64 and arm64).

```bash
npx agentpit                      # start and open the browser
npx agentpit --port 8080 --no-open
npx agentpit link                 # login link + setup code (headless servers)
npx agentpit set-password         # reset the password
npx agentpit install-browser      # Chromium + ffmpeg for browser identities
npm i -g agentpit && agentpit     # install permanently
```

On first start you choose a password in the browser. Data, projects and settings live in `~/.agentpit` (`--home <dir>` or `AGENTPIT_HOME` to change). All options: `.env.example` in the package, copied to `~/.agentpit/.env`.

## Remote access

The server only listens on `127.0.0.1`. Put a tunnel in front of it on the same machine:

```bash
tailscale serve --bg 4317           # private, only your devices
npx agentpit --public-url https://my-box.tailnet-1234.ts.net
```

Cloudflare Tunnel, devtunnel or nginx work the same way (WebSockets must pass through).

## Security

Whoever can open the cockpit can run commands on the machine – that is the point of it. So: a password from the first start, "bypass permissions" locked unless `ALLOW_BYPASS_PERMISSIONS=true`, browser logins always done by you, database passwords kept in `~/.agentpit` – keep that folder private. Automated logins and scraping can violate the terms of the sites you use. agentpit is an interface for **your own** Claude Code with **your own** account; if you offer it to others, use an API key.

## FAQ

**Is this a Claude Code GUI / web UI?** Yes – a self-hosted web interface for Claude Code (via the official Agent SDK) that manages many sessions at once and adds browser automation, workflows and remote access.

**Does it work with my Claude Pro/Max subscription?** Yes, sign in from the UI. An Anthropic API key works too.

**How is this different from Claude in Chrome?** Claude in Chrome lives in your desktop Chrome. agentpit runs headless or windowed browser profiles on the machine running the cockpit (also a server), streams them to any device and lets several sessions use several identities.

**Can it run 24/7 on a home server?** Yes – it is built for Linux servers (an install script for NVIDIA Jetson is in the repo); browsers get a virtual display automatically when there is no screen.

## License

MIT. Not affiliated with Anthropic. Claude is a trademark of Anthropic.
