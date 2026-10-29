// HTTP + WebSocket server. Zero dependencies.
//
//   POST /api/login {id, password}      -> {token, role, profile}        (players and the host)
//   POST /api/logout | GET /api/me | GET /api/meta | GET /api/leaderboard
//   POST /api/daily | /api/rebuy        (players)
//   /api/admin/...                      (host only: accounts, settings, tables, audit log)
//   WS   /ws?token=...                  live tables: join, leave, act -> room snapshots, balance, events
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultGames } from './games/index.js';
import { Accounts } from './accounts.js';
import { RoomManager } from './rooms.js';
import { acceptUpgrade } from './ws.js';
import { ACHIEVEMENTS, TIERS, publicProfile, claimDaily, tierFor } from './progression.js';
import { CHIPS, REBUY_AMOUNT, ADMIN_ID, ADMIN_PASSWORD } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com',
  "img-src 'self' data:", "connect-src 'self' ws: wss:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');
const SECURITY = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };

function limiter(max, windowMs, now) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      const allowed = arr.length < max;
      if (allowed) arr.push(t);
      hits.set(key, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
      return allowed;
    },
    peek(key) {
      const t = now();
      return (hits.get(key) || []).filter((x) => t - x < windowMs).length < max;
    },
  };
}

function readJson(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Bad request.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(obj));
}

/**
 * Build the casino. opts: db (required), games, now, rng, adminId, adminPassword, autoTick.
 * Returns { server, db, accounts, rooms, tick, close }.
 */
export async function createApp({ db, games = defaultGames(), publicDir = DEFAULT_PUBLIC, now = () => Date.now(), rng, adminId = ADMIN_ID, adminPassword = ADMIN_PASSWORD, autoTick = true } = {}) {
  publicDir = path.resolve(publicDir);
  const accounts = new Accounts({ db, now, adminId, adminPassword });
  await accounts.init();
  const rooms = new RoomManager({ db, accounts, games, now, rng });
  rooms.resume(db.loaded ? db.downtime : 0);

  const loginIp = limiter(30, 60_000, now);
  const loginId = limiter(8, 10 * 60_000, now); // failed attempts per id
  const actRate = limiter(40, 1000, now);
  const conns = new Map(); // playerId -> Set<WsConnection>

  const settings = () => db.data.settings;
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const profileOf = (a) => publicProfile(a, now(), { dailyBonus: settings().dailyBonus, freshStart: settings().freshStart, hasStake: rooms.staked(a.id) > 0 });

  /* ---------------------------------------------------------------- live hub */
  const sendTo = (id, obj) => {
    const set = conns.get(id);
    if (!set) return;
    const s = JSON.stringify(obj);
    for (const c of set) c.send(s);
  };
  function pushRoom(gameId) {
    for (const pid of rooms.presence.get(gameId).keys()) {
      const msg = JSON.stringify({ t: 'room', game: gameId, snap: rooms.snapshot(pid, gameId) });
      for (const c of conns.get(pid) || []) if (c.joined.has(gameId)) c.send(msg);
    }
  }
  function flush() {
    const { changed, touched, events } = rooms.drain();
    changed.forEach(pushRoom); // rooms first so clients can hold balance displays before the new balance arrives
    for (const id of touched) {
      const a = accounts.get(id);
      if (a) sendTo(id, { t: 'me', profile: profileOf(a) });
    }
    for (const e of events) sendTo(e.id, { t: 'events', events: e.events });
  }
  let lastLobby = '';
  function pushLobby(force = false) {
    const s = JSON.stringify({ t: 'lobby', tables: rooms.lobby(), serverNow: now() });
    const key = JSON.stringify(rooms.lobby());
    if (!force && key === lastLobby) return;
    lastLobby = key;
    for (const set of conns.values()) for (const c of set) c.send(s);
  }
  function kick(id, reason) {
    for (const c of [...(conns.get(id) || [])]) {
      c.send(JSON.stringify({ t: 'kicked', reason }));
      c.close(4001);
    }
  }
  function tick() {
    rooms.tick();
    flush();
    pushLobby();
  }
  const ticker = autoTick ? setInterval(tick, 250) : null;
  ticker?.unref?.();
  const pinger = setInterval(() => {
    for (const set of conns.values()) for (const c of set) (c.alive ? c.ping() : c.terminate());
  }, 20_000);
  pinger.unref?.();

  /* ---------------------------------------------------------------- HTTP API */
  const meta = () => ({
    ok: true,
    games: games.map(({ id, name, tagline, accent, minBet, maxBet, rules }) => ({ id, name, tagline, accent, minBet, maxBet, rules })),
    achievements: ACHIEVEMENTS.map(({ id, name, desc, reward }) => ({ id, name, desc, reward })),
    tiers: TIERS,
    chips: CHIPS,
    rebuy: REBUY_AMOUNT,
  });

  const adminRow = (a) => ({
    id: a.id, name: a.name, balance: a.balance, disabled: a.disabled, createdAt: a.createdAt, lastLogin: a.lastLogin,
    level: publicProfile(a, now()).level, rounds: a.stats.rounds, net: a.stats.won - a.stats.wagered,
    online: rooms.isOnline(a.id), staked: rooms.staked(a.id),
  });

  async function handleAdmin(req, res, url, body, who) {
    const route = `${req.method} ${url.pathname}`;
    const act = (action, target, detail) => db.audit(who.id, action, target, detail);

    if (route === 'GET /api/admin/overview') {
      return sendJson(res, 200, {
        ok: true,
        accounts: accounts.list().map(adminRow).sort((a, b) => a.id.localeCompare(b.id)),
        settings: settings(),
        tables: rooms.lobby().map((t) => ({ ...t, name: games.find((g) => g.id === t.id).name })),
        audit: db.data.audit.slice(-60).reverse(),
        serverNow: now(),
      });
    }
    if (route === 'POST /api/admin/accounts') {
      const r = await accounts.create(body);
      if (!r.ok) return sendJson(res, 400, r);
      act('create', r.account.id, `balance ${r.account.balance}`);
      return sendJson(res, 200, { ok: true, account: adminRow(r.account) });
    }
    if (route === 'POST /api/admin/settings') {
      for (const k of ['dailyBonus', 'freshStart']) if (typeof body[k] === 'boolean') settings()[k] = body[k];
      act('settings', '-', JSON.stringify(settings()));
      db.dirty();
      for (const set of conns.keys()) rooms.touched.add(set);
      flush();
      return sendJson(res, 200, { ok: true, settings: settings() });
    }
    let m = url.pathname.match(/^\/api\/admin\/tables\/([a-z0-9-]+)\/reset$/);
    if (m && req.method === 'POST') {
      if (!rooms.resetRoom(m[1])) return sendJson(res, 404, { ok: false, error: 'No such table.' });
      act('reset-table', m[1], 'stakes refunded');
      flush();
      return sendJson(res, 200, { ok: true });
    }
    m = url.pathname.match(/^\/api\/admin\/accounts\/([a-z0-9_.-]+)\/(password|balance|name|disable|kick|delete)$/);
    if (m && req.method === 'POST') {
      const [, id, what] = m;
      const a = accounts.get(id);
      if (!a) return sendJson(res, 404, { ok: false, error: 'No such account.' });
      let r;
      if (what === 'password') {
        r = await accounts.setPassword(id, body.password);
        if (r.ok) {
          act('password', id);
          kick(id, 'Your password was changed by the host. Please sign in again.');
        }
      } else if (what === 'balance') {
        r = accounts.setBalance(id, body);
        if (r.ok) {
          act('balance', id, `${r.before} -> ${r.after}`);
          rooms.touched.add(id);
          flush();
        }
      } else if (what === 'name') {
        r = accounts.rename(id, body.name);
        if (r.ok) {
          act('rename', id, a.name);
          rooms.touched.add(id);
          for (const g of games) rooms.changed.add(g.id);
          flush();
        }
      } else if (what === 'disable') {
        r = accounts.setDisabled(id, body.disabled);
        if (r.ok) {
          act(body.disabled ? 'disable' : 'enable', id);
          if (body.disabled) kick(id, 'This account has been switched off by the host.');
        }
      } else if (what === 'kick') {
        accounts.revokeAccount(id);
        kick(id, 'You were signed out by the host.');
        act('kick', id);
        r = { ok: true };
      } else {
        r = accounts.remove(id);
        if (r.ok) {
          act('delete', id);
          kick(id, 'This account was removed by the host.');
        }
      }
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, account: accounts.get(id) ? adminRow(accounts.get(id)) : null } : r);
    }
    return sendJson(res, 404, { ok: false, error: 'Not found.' });
  }

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/meta') return sendJson(res, 200, meta());
    const body = req.method === 'POST' ? await readJson(req) : {};

    if (route === 'POST /api/login') {
      const ip = clientIp(req);
      const id = String(body.id ?? '').trim().toLowerCase().slice(0, 40);
      if (!loginIp.take(ip) || !loginId.peek(id)) return sendJson(res, 429, { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' });
      const v = await accounts.verify(id, body.password);
      if (!v.ok) {
        loginId.take(id); // only failures count against the id
        return sendJson(res, 401, v);
      }
      const token = accounts.createSession(v.id, v.role);
      return sendJson(res, 200, { ok: true, token, role: v.role, profile: v.role === 'player' ? profileOf(accounts.get(v.id)) : null, name: v.role === 'admin' ? 'Host' : accounts.get(v.id).name });
    }

    const who = accounts.session(bearer(req));
    if (!who) return sendJson(res, 401, { ok: false, error: 'Please sign in again.' });

    if (route === 'POST /api/logout') {
      accounts.revokeToken(bearer(req));
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'GET /api/me') return sendJson(res, 200, { ok: true, role: who.role, profile: who.role === 'player' ? profileOf(who.account) : null, name: who.role === 'admin' ? 'Host' : who.account.name });

    if (url.pathname.startsWith('/api/admin/')) {
      if (who.role !== 'admin') return sendJson(res, 403, { ok: false, error: 'Host access only.' });
      return handleAdmin(req, res, url, body, who);
    }

    if (route === 'GET /api/leaderboard') {
      const list = accounts.list().filter((a) => !a.disabled).sort((a, b) => b.balance - a.balance);
      const top = list.slice(0, 10).map((q) => ({ id: q.id, name: q.name, balance: q.balance, tier: tierFor(q.stats.wagered).name }));
      const rank = who.role === 'player' ? list.findIndex((q) => q.id === who.id) + 1 : 0;
      return sendJson(res, 200, { ok: true, top, me: { id: who.id, rank }, players: list.length });
    }

    if (who.role !== 'player') return sendJson(res, 403, { ok: false, error: 'Players only.' });
    const a = who.account;
    if (route === 'POST /api/daily') {
      if (!settings().dailyBonus) return sendJson(res, 400, { ok: false, error: 'The daily bonus is switched off.' });
      const r = claimDaily(a, now());
      if (!r.ok) return sendJson(res, 400, r);
      db.dirty();
      return sendJson(res, 200, { ...r, profile: profileOf(a) });
    }
    if (route === 'POST /api/rebuy') {
      if (!profileOf(a).canRebuy) return sendJson(res, 400, { ok: false, error: 'A fresh start is not available right now.' });
      a.balance += REBUY_AMOUNT;
      a.stats.rebuys++;
      db.dirty();
      return sendJson(res, 200, { ok: true, amount: REBUY_AMOUNT, profile: profileOf(a) });
    }
    return sendJson(res, 404, { ok: false, error: 'Not found.' });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY);
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400, SECURITY);
      return res.end();
    }
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.includes('\0')) {
      res.writeHead(400, SECURITY);
      return res.end();
    }
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(403, SECURITY);
      return res.end('Forbidden');
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY });
        return res.end('Not found');
      }
      const ext = path.extname(file).toLowerCase();
      const cache = ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600';
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, ...SECURITY });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...SECURITY });
        return res.end('ok');
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { ok: false, error: status === 500 ? 'Something went wrong.' : e.message });
    }
  });

  /* ---------------------------------------------------------------- WebSocket */
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    if (url.pathname !== '/ws' || (origin && new URL(origin).host !== req.headers.host)) {
      socket.destroy();
      return;
    }
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    const who = accounts.session(url.searchParams.get('token'));
    if (!who || who.role !== 'player') {
      conn.send(JSON.stringify({ t: 'kicked', reason: 'Please sign in again.' }));
      conn.close(4001);
      return;
    }
    const id = who.id;
    conn.joined = new Set();
    if (!conns.has(id)) conns.set(id, new Set());
    conns.get(id).add(conn);
    rooms.setOnline(id, conns.get(id).size);
    conn.send(JSON.stringify({ t: 'hello', serverNow: now(), profile: profileOf(accounts.get(id)), tables: rooms.lobby() }));

    conn.on('message', (text) => {
      if (text.length > 8000) return;
      if (!actRate.take(id)) return conn.send(JSON.stringify({ t: 'error', error: 'Slow down a little.' }));
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (!accounts.get(id) || accounts.get(id).disabled) return;
      if (m.t === 'join' && typeof m.game === 'string' && !conn.joined.has(m.game)) {
        if (rooms.join(id, m.game)) conn.joined.add(m.game);
      } else if (m.t === 'leave' && conn.joined.has(m.game)) {
        conn.joined.delete(m.game);
        rooms.leave(id, m.game);
      } else if (m.t === 'act' && conn.joined.has(m.game)) {
        const r = rooms.act(id, m.game, m.action);
        conn.send(JSON.stringify({ t: 'ack', rid: m.rid, ok: r.ok, error: r.error }));
      }
      flush();
      pushLobby();
    });
    conn.on('close', () => {
      const set = conns.get(id);
      set?.delete(conn);
      for (const g of conn.joined) rooms.leave(id, g);
      if (set && !set.size) conns.delete(id);
      rooms.setOnline(id, set?.size || 0);
      flush();
      pushLobby();
    });
  });

  return {
    server, db, accounts, rooms, tick, flush,
    close() {
      clearInterval(ticker);
      clearInterval(pinger);
      for (const set of conns.values()) for (const c of set) c.terminate();
      server.close();
      db.flush();
    },
  };
}
