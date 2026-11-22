// Installs the bundled Chromium and Playwright's ffmpeg (for browser video recording)
// into ./browsers (PLAYWRIGHT_BROWSERS_PATH). Linux: add --with-deps once (needs sudo).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';

const cli = path.join(ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');
if (!fs.existsSync(cli)) { console.error('Erst npm install ausführen.'); process.exit(1); }
const extra = process.argv.includes('--with-deps') ? ['--with-deps'] : [];
console.log(`Installiere Chromium + ffmpeg nach ${process.env.PLAYWRIGHT_BROWSERS_PATH} …`);
const r = spawnSync(process.execPath, [cli, 'install-browser', 'chromium', 'ffmpeg', '--no-shell', ...extra], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
