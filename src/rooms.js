// RoomManager: one persistent table per game. It owns presence (who is at the table), the context
// engines use to touch wallets, the clock tick, and the outbox the server drains to push updates.
import crypto from 'node:crypto';
import { recordRound } from './progression.js';

export class RoomManager {
  constructor({ db, accounts, games, now = () => Date.now(), rng }) {
    this.db = db;
    this.accounts = accounts;
    this.now = now;
    this.rng = rng || ((n) => crypto.randomInt(n));
    this.games = new Map(games.map((g) => [g.id, g]));
    this.presence = new Map(); // gameId -> Map(playerId -> number of open tabs in the room)
    this.onlineCount = new Map(); // playerId -> open connections
    this.changed = new Set();
    this.touched = new Set();
    this.events = [];
    for (const g of games) {
      if (!db.data.rooms[g.id]) db.data.rooms[g.id] = g.init();
      this.presence.set(g.id, new Map());
    }
  }

  /** After a restart: keep every countdown exactly where it was (plus a short grace to reconnect). */
  resume(downtime) {
    const now = this.now();
    for (const s of Object.values(this.db.data.rooms)) {
      if (s.deadline != null) s.deadline = Math.max(s.deadline + downtime, now + 5000);
    }
  }

  state(gameId) {
    return this.db.data.rooms[gameId];
  }

  isOnline(id) {
    return (this.onlineCount.get(id) || 0) > 0;
  }
  setOnline(id, n) {
    if (n > 0) this.onlineCount.set(id, n);
    else this.onlineCount.delete(id);
  }

  ctx(gameId) {
    const self = this;
    return {
      rng: self.rng,
      now: self.now(),
      online: (id) => self.isOnline(id),
      name: (id) => self.accounts.get(id)?.name ?? id,
      exists: (id) => !!self.accounts.get(id),
      balance: (id) => self.accounts.get(id)?.balance ?? 0,
      debit(id, n) {
        const a = self.accounts.get(id);
        if (!a || n < 0 || a.balance < n) return false;
        a.balance -= n;
        self.touched.add(id);
        return true;
      },
      credit(id, n) {
        const a = self.accounts.get(id);
        if (!a || n < 0) return;
        a.balance += n;
        self.touched.add(id);
      },
      settle(id, settled) {
        const a = self.accounts.get(id);
        if (!a) return;
        const ev = recordRound(a, gameId, settled, self.now());
        self.touched.add(id);
        if (ev.length) self.events.push({ id, events: ev });
      },
    };
  }

  join(pid, gameId) {
    const m = this.presence.get(gameId);
    if (!m) return false;
    m.set(pid, (m.get(pid) || 0) + 1);
    this.changed.add(gameId);
    return true;
  }
  leave(pid, gameId) {
    const m = this.presence.get(gameId);
    if (!m || !m.has(pid)) return;
    if (m.get(pid) <= 1) m.delete(pid);
    else m.set(pid, m.get(pid) - 1);
    this.changed.add(gameId);
  }

  act(pid, gameId, action) {
    const g = this.games.get(gameId);
    if (!g) return { ok: false, error: 'No such table.' };
    const r = g.act(this.state(gameId), pid, action, this.now(), this.ctx(gameId));
    if (r.ok) {
      this.changed.add(gameId);
      this.db.dirty();
    }
    return r;
  }

  tick() {
    const now = this.now();
    for (const g of this.games.values()) {
      if (g.tick(this.state(g.id), now, this.ctx(g.id))) {
        this.changed.add(g.id);
        this.db.dirty();
      }
    }
  }

  snapshot(pid, gameId) {
    const g = this.games.get(gameId);
    const people = [...this.presence.get(gameId).keys()].map((id) => ({ id, name: this.accounts.get(id)?.name ?? id }));
    return { game: gameId, serverNow: this.now(), view: g.view(this.state(gameId), pid, this.now(), this.ctx(gameId)), people };
  }

  lobby() {
    return [...this.games.values()].map((g) => ({
      id: g.id,
      online: this.presence.get(g.id).size,
      ...g.summary(this.state(g.id)),
    }));
  }

  staked(pid) {
    let n = 0;
    for (const g of this.games.values()) n += g.staked(this.state(g.id), pid);
    return n;
  }

  /** Host tool: refund every stake and start the table over. */
  resetRoom(gameId) {
    const g = this.games.get(gameId);
    if (!g) return false;
    this.db.data.rooms[gameId] = g.reset(this.state(gameId), this.ctx(gameId));
    this.changed.add(gameId);
    this.db.dirty();
    return true;
  }

  drain() {
    const out = { changed: [...this.changed], touched: [...this.touched], events: this.events };
    this.changed = new Set();
    this.touched = new Set();
    this.events = [];
    return out;
  }
}
