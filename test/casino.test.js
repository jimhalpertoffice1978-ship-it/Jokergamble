import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db.js';
import { createApp } from '../src/server.js';
import { defaultGames } from '../src/games/index.js';

const FAST = { blackjack: { timing: { bet: 400, turn: 400, offline: 50, result: 150, draw: 5 } }, roulette: { timing: { bet: 400, spin: 150, result: 150 } } };
const ADMIN = { adminId: 'boss', adminPassword: 'Sup3rSecret!' };

async function boot(file, extra = {}) {
  const db = new Database({ file });
  const app = await createApp({ db, games: defaultGames(FAST), autoTick: false, ...ADMIN, ...extra });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, ...(await res.json()) };
  };
  return { app, db, base, api };
}

function client(base, token) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
  const msgs = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    msgs.push(m);
    waiters.splice(0).forEach((w) => w());
  };
  const opened = new Promise((r) => (ws.onopen = r));
  const until = async (fn, ms = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = fn(msgs);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for message');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return {
    ws, msgs, opened, until,
    send: (o) => ws.send(JSON.stringify(o)),
    last: (t) => [...msgs].reverse().find((m) => m.t === t),
  };
}

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jg-')), 'casino.json');

test('host logs in, creates accounts; players cannot use admin routes', async () => {
  const { app, api } = await boot(null);
  try {
    assert.equal((await api('POST', '/api/login', { id: 'boss', password: 'nope' })).status, 401);
    const host = await api('POST', '/api/login', { id: 'boss', password: 'Sup3rSecret!' });
    assert.equal(host.role, 'admin');
    const made = await api('POST', '/api/admin/accounts', { id: 'alice', password: 'secret1', name: 'Alice', balance: 2000 }, host.token);
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal((await api('POST', '/api/admin/accounts', { id: 'alice', password: 'secret1' }, host.token)).status, 400);
    const a = await api('POST', '/api/login', { id: 'alice', password: 'secret1' });
    assert.equal(a.role, 'player');
    assert.equal(a.profile.balance, 2000);
    assert.equal((await api('GET', '/api/admin/overview', null, a.token)).status, 403);
    const pw = await api('POST', '/api/admin/accounts/alice/password', { password: 'newpass1' }, host.token);
    assert.ok(pw.ok);
    assert.equal((await api('GET', '/api/me', null, a.token)).status, 401, 'old sessions revoked');
    assert.equal((await api('POST', '/api/login', { id: 'alice', password: 'newpass1' })).role, 'player');
    const bal = await api('POST', '/api/admin/accounts/alice/balance', { add: 500 }, host.token);
    assert.equal(bal.account.balance, 2500);
    await api('POST', '/api/admin/accounts/alice/disable', { disabled: true }, host.token);
    assert.equal((await api('POST', '/api/login', { id: 'alice', password: 'newpass1' })).status, 401);
    assert.ok((await api('GET', '/api/admin/overview', null, host.token)).audit.length >= 4);
  } finally {
    app.close();
  }
});

test('two players share one table, bets are shared and money is conserved', async () => {
  const { app, api, base } = await boot(null);
  try {
    const host = await api('POST', '/api/login', { id: 'boss', password: 'Sup3rSecret!' });
    const toks = {};
    for (const id of ['amy', 'bob']) {
      await api('POST', '/api/admin/accounts', { id, password: 'secret1', name: id.toUpperCase(), balance: 1000 }, host.token);
      toks[id] = (await api('POST', '/api/login', { id, password: 'secret1' })).token;
    }
    const amy = client(base, toks.amy);
    const bob = client(base, toks.bob);
    await Promise.all([amy.opened, bob.opened]);
    for (const c of [amy, bob]) c.send({ t: 'join', game: 'roulette' });
    await amy.until(() => amy.last('room'));
    amy.send({ t: 'act', game: 'roulette', rid: 1, action: { type: 'setBets', bets: [{ type: 'red', sel: null, amount: 100 }] } });
    bob.send({ t: 'act', game: 'roulette', rid: 1, action: { type: 'setBets', bets: [{ type: 'black', sel: null, amount: 100 }] } });
    await bob.until((m) => m.find((x) => x.t === 'ack' && x.rid === 1));
    app.tick();
    const snap = (await amy.until((m) => m.filter((x) => x.t === 'room').at(-1)?.snap.view.players.length === 2 && m.filter((x) => x.t === 'room').at(-1))).snap;
    assert.equal(snap.people.length, 2);
    assert.ok(snap.view.deadline > 0, 'countdown started by first bet');
    const rid = (c) => c.msgs.find((x) => x.t === 'ack' && x.rid === 1);
    assert.ok(rid(amy).ok && rid(bob).ok);
    // run the clock until the spin is settled
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      app.tick();
    }
    const st = app.rooms.state('roulette');
    assert.equal(st.phase, 'betting', 'spin settled and table reopened');
    assert.ok(st.history.length === 1, 'one spin recorded');
    const a = app.accounts.get('amy').balance;
    const b = app.accounts.get('bob').balance;
    // red and black can't both win; achievement bonuses may add a little on top of the payout
    assert.ok(a >= 900 && b >= 900, `balances ${a}/${b}`);
    assert.ok(a + b >= (st.history[0] === 0 ? 1800 : 2000), `total ${a + b}`);
    assert.equal(app.accounts.get('amy').stats.rounds, 1);
    amy.ws.close();
    bob.ws.close();
  } finally {
    app.close();
  }
});

test('restart resumes the table mid-countdown with accounts and bets intact', async () => {
  const file = tmp();
  let t = 1_000_000;
  const now = () => t;
  const one = async () => {
    const db = new Database({ file, now });
    const app = await createApp({ db, games: defaultGames({ roulette: { timing: { bet: 20_000, spin: 5000, result: 3000 } } }), autoTick: false, now, ...ADMIN });
    return app;
  };
  let app = await one();
  await app.accounts.create({ id: 'cat', password: 'secret1', name: 'Cat', balance: 1000 });
  app.rooms.join('cat', 'roulette');
  assert.ok(app.rooms.act('cat', 'roulette', { type: 'setBets', bets: [{ type: 'red', sel: null, amount: 50 }] }).ok);
  const deadline = app.rooms.state('roulette').deadline;
  assert.equal(deadline, t + 20_000);
  t += 8000; // 12s left on the clock
  app.db.flush();
  app.close();
  t += 60_000; // server was down for a minute
  app = await one();
  const s = app.rooms.state('roulette');
  assert.equal(s.phase, 'betting');
  assert.equal(s.bets.cat[0].amount, 50);
  assert.equal(s.deadline, t + 12_000, 'same time left as when it stopped');
  assert.equal(app.accounts.get('cat').balance, 950);
  assert.equal((await app.accounts.verify('cat', 'secret1')).ok, true);
  assert.equal((await app.accounts.verify('boss', 'Sup3rSecret!')).role, 'admin');
  app.close();
});

test('blackjack table runs a full round for two seats', async () => {
  let t = 1000;
  const now = () => t;
  const db = new Database({ now });
  const app = await createApp({ db, games: defaultGames(), autoTick: false, now, ...ADMIN });
  try {
    for (const id of ['ann', 'ben']) await app.accounts.create({ id, password: 'secret1', balance: 1000 });
    const { rooms } = app;
    for (const id of ['ann', 'ben']) rooms.join(id, 'blackjack');
    assert.ok(rooms.act('ann', 'blackjack', { type: 'bet', amount: 100 }).ok);
    assert.ok(rooms.act('ben', 'blackjack', { type: 'bet', amount: 50 }).ok);
    assert.ok(rooms.act('ann', 'blackjack', { type: 'ready' }).ok);
    assert.ok(rooms.act('ben', 'blackjack', { type: 'ready' }).ok);
    for (let i = 0; i < 400 && rooms.state('blackjack').phase !== 'betting' || i < 2; i++) {
      t += 700;
      rooms.tick();
      const s = rooms.state('blackjack');
      if (s.phase === 'playing') for (const id of ['ann', 'ben']) rooms.act(id, 'blackjack', { type: 'stand' });
      if (i > 2 && s.phase === 'betting') break;
    }
    assert.equal(rooms.state('blackjack').phase, 'betting');
    assert.ok(rooms.state('blackjack').round >= 2);
    const total = app.accounts.get('ann').balance + app.accounts.get('ben').balance;
    assert.ok(total <= 2000 + 150 * 2.5 && total >= 2000 - 150 * 2, `total ${total}`);
    assert.equal(rooms.staked('ann'), 0);
  } finally {
    app.close();
  }
});
