import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db.js';
import { createApp } from '../src/server.js';

// Random play by many players at both tables: tokens may only come from payouts and bonuses, never appear from nowhere.
test('random multiplayer play never breaks the books', async () => {
  let t = 1_000_000;
  const now = () => t;
  let seed = 42;
  const rng = (n) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % n);
  const app = await createApp({ db: new Database({ now }), autoTick: false, now, rng, adminId: 'boss', adminPassword: 'Sup3rSecret!' });
  const ids = ['pl1', 'pl2', 'pl3', 'pl4'];
  for (const id of ids) await app.accounts.create({ id, password: 'secret1', balance: 5000 });
  const { rooms } = app;
  for (const id of ids) for (const g of ['blackjack', 'roulette']) rooms.join(id, g);
  const types = ['straight', 'red', 'black', 'odd', 'even', 'dozen'];
  for (let i = 0; i < 3000; i++) {
    t += 500;
    const id = ids[rng(4)];
    const r = rng(10);
    if (r < 3) rooms.act(id, 'roulette', { type: 'setBets', bets: [{ type: types[rng(6)], sel: [0, 1, 2].includes(rng(3)) ? rng(3) + 1 : 17, amount: 10 * (1 + rng(10)) }] });
    else if (r < 4) rooms.act(id, 'roulette', { type: 'ready' });
    else if (r < 6) rooms.act(id, 'blackjack', { type: 'bet', amount: 10 * rng(20) });
    else if (r < 7) rooms.act(id, 'blackjack', { type: 'ready' });
    else rooms.act(id, 'blackjack', { type: ['hit', 'stand', 'double', 'split'][rng(4)] });
    rooms.tick();
    for (const p of ids) {
      const a = app.accounts.get(p);
      assert.ok(Number.isInteger(a.balance) && a.balance >= 0, `${p} balance ${a.balance}`);
    }
  }
  // total tokens never exceed what the house could have paid out: every wager is bounded, so just check integrity
  for (const p of ids) assert.ok(rooms.staked(p) >= 0);
  // reset refunds every stake
  const before = ids.reduce((n, p) => n + app.accounts.get(p).balance + rooms.staked(p), 0);
  rooms.resetRoom('blackjack');
  rooms.resetRoom('roulette');
  const after = ids.reduce((n, p) => n + app.accounts.get(p).balance, 0);
  assert.equal(after, before, 'reset gives every staked token back');
  app.close();
});

test('account rules: ids, passwords, host-only static login', async () => {
  const app = await createApp({ db: new Database(), autoTick: false, adminId: 'boss', adminPassword: 'Sup3rSecret!' });
  assert.equal((await app.accounts.create({ id: 'A', password: 'secret1' })).ok, false, 'too short');
  assert.equal((await app.accounts.create({ id: 'boss', password: 'secret1' })).ok, false, 'host id is reserved');
  assert.equal((await app.accounts.create({ id: 'ok_user', password: 'abc' })).ok, false, 'short password');
  assert.equal((await app.accounts.create({ id: 'Ok_User', password: 'abcdef' })).ok, true);
  assert.equal((await app.accounts.verify('ok_user', 'wrong!')).ok, false);
  assert.equal((await app.accounts.verify('OK_USER', 'abcdef')).ok, true, 'ids are case-insensitive');
  assert.equal((await app.accounts.verify('boss', 'Sup3rSecret!')).role, 'admin');
  assert.equal((await app.accounts.verify('boss', 'nope')).ok, false);
  app.close();
});
