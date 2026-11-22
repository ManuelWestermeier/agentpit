// Sets or resets the cockpit login password (normally done in the browser on first open).
// Use this if you forgot it – every session is signed out.
//   npm run set-password            – asks interactively
//   COCKPIT_PASSWORD=… npm run set-password
import fs from 'node:fs';
import readline from 'node:readline';
import { config } from '../server/config.js';
import { hashPassword, passwordFile, setupCodeFile, validatePassword } from '../server/security.js';

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
  const a = await new Promise((r) => rl.question(q, r));
  rl.close();
  process.stdout.write('\n');
  return a;
}

let pw = process.env.COCKPIT_PASSWORD;
if (!pw) {
  pw = await ask('Neues Passwort (min. 4 Zeichen): ');
  if (pw !== await ask('Wiederholen: ')) { console.error('Passwörter stimmen nicht überein.'); process.exit(1); }
}
const err = validatePassword(pw);
if (err) { console.error(err); process.exit(1); }
const file = passwordFile(config.dataDir);
let rev = 0;
try { rev = JSON.parse(fs.readFileSync(file, 'utf8')).rev ?? 1; } catch { /* first password */ }
fs.mkdirSync(config.dataDir, { recursive: true });
fs.writeFileSync(file, JSON.stringify(hashPassword(pw, rev + 1)), { mode: 0o600 });
fs.rmSync(setupCodeFile(config.dataDir), { force: true });
console.log(`Gespeichert in ${file}. Gilt sofort; alle bisherigen Anmeldungen sind abgemeldet.`);
