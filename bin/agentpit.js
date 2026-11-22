#!/usr/bin/env node
// agentpit – CLI entry: `npx agentpit` starts the cockpit; subcommands for the admin scripts.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`agentpit needs Node.js 22.13 or newer (you have ${process.versions.node}). https://nodejs.org`);
  process.exit(1);
}

const HELP = `agentpit ${pkg.version} – web cockpit for many parallel Claude Code agents

Usage
  npx agentpit [options]          start (opens the browser)
  npx agentpit link               print the login link and setup code
  npx agentpit set-password       set a new password (signs everyone out)
  npx agentpit install-browser    download Chromium + ffmpeg for browser identities

Options
  --port <n>        HTTP port (default 4317, preview uses port + 1)
  --home <dir>      where data, projects and .env live (default ~/.agentpit)
  --no-open         do not open a browser window
  --public-url <u>  public HTTPS address when reached through a tunnel
  -v, --version     print the version
  -h, --help        this help

Settings: <home>/.env (see .env.example in the package). Needs Claude Code login or ANTHROPIC_API_KEY.`;

const args = process.argv.slice(2);
const cmds = { link: '../scripts/link.mjs', 'set-password': '../scripts/set-password.mjs', 'install-browser': '../scripts/install-browser.mjs' };
let cmd = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    const v = args[++i];
    if (v == null) { console.error(`${a} needs a value`); process.exit(1); }
    return v;
  };
  if (a === '-h' || a === '--help' || a === 'help') { console.log(HELP); process.exit(0); }
  else if (a === '-v' || a === '--version') { console.log(pkg.version); process.exit(0); }
  else if (a === '--port') process.env.PORT = val();
  else if (a === '--home') process.env.AGENTPIT_HOME = val();
  else if (a === '--no-open') process.env.OPEN_BROWSER = 'false';
  else if (a === '--public-url') process.env.PUBLIC_URL = val();
  else if (a === 'start') cmd = null;
  else if (cmds[a]) cmd = a;
  else { console.error(`Unknown argument: ${a}\n\n${HELP}`); process.exit(1); }
}

await import(cmd ? cmds[cmd] : '../server/index.js');
