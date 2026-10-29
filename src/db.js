// The one place everything lives: accounts, sessions, settings, audit log and the state of
// every game room. It is saved as a single JSON file (atomic rename, with a .bak copy) so a
// restart brings back wallets AND half-played rounds exactly as they were.
import fs from 'node:fs';
import path from 'node:path';

const fresh = () => ({
  v: 2,
  savedAt: 0,
  settings: { dailyBonus: true, freshStart: true },
  accounts: {},
  sessions: {},
  rooms: {},
  audit: [],
});

export class Database {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.timer = null;
    this.data = fresh();
    this.loaded = false;
    this.downtime = 0; // ms between the last save and this start (used to resume countdowns)
    if (file) this.load();
  }

  load() {
    for (const f of [this.file, `${this.file}.bak`]) {
      try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const base = fresh();
        this.data = { ...base, ...raw, settings: { ...base.settings, ...(raw.settings || {}) } };
        this.loaded = true;
        this.downtime = Math.max(0, this.now() - (this.data.savedAt || this.now()));
        return;
      } catch {
        /* try the backup, then start empty */
      }
    }
  }

  /** Debounced save: many changes within 250ms become one write. */
  dirty() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.data.savedAt = this.now();
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      try {
        fs.copyFileSync(this.file, `${this.file}.bak`);
      } catch {
        /* first save: nothing to back up */
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Could not save the casino state:', e.message);
    }
  }

  audit(actor, action, target, detail = '') {
    this.data.audit.push({ t: this.now(), actor, action, target, detail });
    if (this.data.audit.length > 300) this.data.audit.splice(0, this.data.audit.length - 300);
    this.dirty();
  }
}
