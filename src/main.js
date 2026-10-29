import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './db.js';
import { createApp } from './server.js';
import { ADMIN_ID, DEFAULT_ADMIN_PASSWORD, ADMIN_PASSWORD } from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const port = Number(process.env.PORT) || 3000;

const db = new Database({ file: path.join(dataDir, 'casino.json') });
const app = await createApp({ db });

app.server.listen(port, '0.0.0.0', () => {
  const players = Object.keys(db.data.accounts).length;
  console.log(`JokerGamble is open at http://localhost:${port}`);
  console.log(db.loaded ? `Resumed from saved state: ${players} accounts, tables restored (${Math.round(db.downtime / 1000)}s downtime).` : 'Fresh start: no saved state found.');
  console.log(`Host login id: ${ADMIN_ID}`);
  if (ADMIN_PASSWORD === DEFAULT_ADMIN_PASSWORD) console.warn('WARNING: using the built-in default host password. Set ADMIN_PASSWORD (and ADMIN_ID) before going public.');
});

// Keep "last saved" fresh so a crash can still resume countdowns accurately.
setInterval(() => db.flush(), 5000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    db.flush();
    process.exit(0);
  });
}
