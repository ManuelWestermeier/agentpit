# Launch kit (not part of the npm package)

Post in this order, one per day, and answer every comment in the first hours – that is what ranks posts.
Always lead with the GIF/screenshot of Claude driving the browser; it is the one thing people have not seen.

## 1. Show HN (Tuesday–Thursday, 15:00–17:00 CET)

**Title:** Show HN: agentpit – run many Claude Code agents in parallel, with real logged-in browsers

**Text:**
I kept juggling five terminal tabs of Claude Code and wanted to check on them from my phone, so I built a web cockpit around the official Claude Agent SDK.

`npx agentpit` starts it locally. Each project gets its own Claude Code session and git repo. The part I use most: browser identities – separate Chrome/Edge/Chromium profiles with persistent logins that Claude drives through Playwright MCP while I watch the live stream and can take over for 2FA. One session can switch identities mid-task.

Other bits: sub-sessions and cron schedules for multi-step workflows, an access gate that still asks before touching other projects' databases even in auto mode, per-answer cost/time limits, microservices with health checks, context logs that survive compaction.

It binds to 127.0.0.1 and is meant to sit behind Tailscale or a tunnel. MIT, Windows/macOS/Linux.

Happy to answer questions – especially interested in how others run long-lived agents.

## 2. Reddit

- r/ClaudeAI – title: "I built a web cockpit for Claude Code: parallel sessions, real browsers with your logins, workflows, phone control (open source, npx agentpit)"
- r/selfhosted – focus: self-hosted, Tailscale, runs 24/7 on a home server, password + tunnel setup
- r/LocalLLaMA is the wrong audience (Claude-only) – skip
- r/webdev / r/node – focus: the CDP relay and streaming with backpressure (technical write-up)

Body: 3 sentences what it is, the screenshot, `npx agentpit`, link, "feedback welcome". No marketing words.

## 3. X / LinkedIn / Bluesky

> Claude Code, but 10 at once – and each one can use a real browser you are logged into, while you watch from your phone.
> `npx agentpit` · MIT · [GIF]

Tag nobody unasked. Post the 20–30 s screen recording natively (not a link) – videos get far more reach.

## 4. Lists and directories (one-time, high long-term value)

- awesome-claude-code (hesreallyhim/awesome-claude-code) – PR under "Tooling / UIs"
- awesome-mcp-clients / awesome-mcp-servers lists (as a client that ships Playwright MCP)
- awesome-selfhosted (needs a public repo with a release; category "Software Development")
- Product Hunt (prepare 4 images + the GIF; launch 00:01 PST)
- dev.to / Hashnode article: "How I let Claude Code use my logged-in browser safely"

## 5. Things that multiply reach

- Public GitHub repo with topics: claude-code, ai-agents, browser-automation, mcp, self-hosted, playwright
- A 30 s demo video in the README (GIF ≤ 5 MB or an mp4 link)
- A GitHub release for every npm version (people watch releases)
- Answer issues fast in the first weeks; add "good first issue" labels
