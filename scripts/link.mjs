// Prints the one-time access links (useful on a headless server).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';

const file = path.join(config.dataDir, '.token');
if (!fs.existsSync(file)) { console.error('Noch kein Token – Server einmal starten.'); process.exit(1); }
const token = fs.readFileSync(file, 'utf8').trim();
for (const base of [`http://localhost:${config.port}`, ...config.publicUrls]) console.log(`${base}/?token=${token}`);

const code = path.join(config.dataDir, '.setup-code');
if (fs.existsSync(code)) console.log(`Einrichtungscode (Passwort noch nicht gesetzt): ${fs.readFileSync(code, 'utf8').trim()}`);
