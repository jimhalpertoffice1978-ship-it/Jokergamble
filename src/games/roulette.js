// Multiplayer Roulette: ONE shared wheel. Players place chips during a countdown, the server spins
// (European single zero, 97.30% return on every bet), everyone is paid at the same moment.
// State is plain JSON so a half-finished spin survives a server restart.
import { PAYOUT, coverage, colorOf, betKey } from '../../public/games/roulette-rules.js';

export const MIN_SPOT = 10; // minimum per betting spot
export const MAX_TOTAL = 10000; // maximum per player per spin
export const MAX_SPOTS = 60;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const sum = (bets) => (bets || []).reduce((n, b) => n + b.amount, 0);

export function createRoulette({ timing } = {}) {
  const T = { bet: 25_000, spin: 7_000, result: 5_500, ...timing };

  const init = () => ({
    phase: 'betting', // betting -> spinning -> result -> betting ...
    round: 1,
    deadline: null,
    bets: {}, // id -> [{type, sel, amount}]
    ready: {},
    number: null,
    history: [],
    results: null, // id -> { wagered, returned, net, bets: [{type, sel, amount, win, payout}] }
    lastBets: {},
  });

  function spin(s, now, ctx) {
    s.number = ctx.rng(37);
    s.phase = 'spinning';
    s.deadline = now + T.spin;
  }

  function settle(s, now, ctx) {
    const n = s.number;
    const results = {};
    for (const [id, bets] of Object.entries(s.bets)) {
      let returned = 0;
      const tags = [];
      const settled = bets.map((b) => {
        const win = coverage(b.type, b.sel).includes(n);
        const payout = win ? b.amount * (PAYOUT[b.type] + 1) : 0;
        returned += payout;
        if (win && b.type === 'straight') tags.push('straight_hit');
        return { type: b.type, sel: b.sel, amount: b.amount, win, payout };
      });
      const wagered = sum(bets);
      if (returned) ctx.credit(id, returned);
      ctx.settle(id, { wagered, returned, tags });
      results[id] = { wagered, returned, net: returned - wagered, bets: settled };
      s.lastBets[id] = bets.map(({ type, sel, amount }) => ({ type, sel, amount }));
    }
    s.history = [n, ...s.history].slice(0, 30);
    s.results = results;
    s.phase = 'result';
    s.deadline = now + T.result;
  }

  function tick(s, now, ctx) {
    if (s.deadline == null || now < s.deadline) return false;
    if (s.phase === 'betting') {
      if (Object.keys(s.bets).length) spin(s, now, ctx);
      else s.deadline = null;
      return true;
    }
    if (s.phase === 'spinning') {
      settle(s, now, ctx);
      return true;
    }
    if (s.phase === 'result') {
      Object.assign(s, { phase: 'betting', round: s.round + 1, bets: {}, ready: {}, number: null, results: null, deadline: null });
      return true;
    }
    return false;
  }

  function act(s, pid, a, now, ctx) {
    if (a?.type === 'setBets') {
      if (s.phase !== 'betting') return fail('Bets are closed for this spin.');
      if (!Array.isArray(a.bets) || a.bets.length > MAX_SPOTS) return fail('Too many bets on the table.');
      const merged = new Map();
      for (const b of a.bets) {
        if (!b || typeof b !== 'object' || PAYOUT[b.type] === undefined || !coverage(b.type, b.sel)) return fail('Invalid bet.');
        if (!Number.isInteger(b.amount) || b.amount < MIN_SPOT || b.amount > MAX_TOTAL) return fail(`Each bet must be ${MIN_SPOT} tokens or more.`);
        const sel = Array.isArray(b.sel) ? [...b.sel].sort((x, y) => x - y) : b.sel;
        const key = betKey(b.type, sel);
        if (merged.has(key)) merged.get(key).amount += b.amount;
        else merged.set(key, { type: b.type, sel, amount: b.amount });
      }
      const bets = [...merged.values()];
      const total = sum(bets);
      if (total > MAX_TOTAL) return fail(`Maximum ${MAX_TOTAL} tokens per spin.`);
      const diff = total - sum(s.bets[pid]);
      if (diff > 0) {
        if (ctx.balance(pid) < diff) return fail('Not enough tokens for those bets.');
        ctx.debit(pid, diff);
      } else if (diff < 0) ctx.credit(pid, -diff);
      if (bets.length) s.bets[pid] = bets;
      else delete s.bets[pid];
      s.ready = {};
      const any = Object.keys(s.bets).length > 0;
      if (!any) s.deadline = null;
      else if (s.deadline == null) s.deadline = now + T.bet; // first chips start the countdown
      return OK;
    }
    if (a?.type === 'ready') {
      if (s.phase !== 'betting' || !s.bets[pid]) return fail('Place a bet first.');
      s.ready[pid] = true;
      if (Object.keys(s.bets).every((id) => s.ready[id])) spin(s, now, ctx); // everyone is ready: spin now
      return OK;
    }
    return fail('Unknown move.');
  }

  function view(s, pid, now, ctx) {
    const shown = s.phase === 'spinning' || s.phase === 'result';
    return {
      phase: s.phase,
      round: s.round,
      deadline: s.deadline,
      number: shown ? s.number : null,
      color: shown ? colorOf(s.number) : null,
      history: s.history,
      players: Object.keys(s.bets).map((id) => ({ id, name: ctx.name(id), total: sum(s.bets[id]), ready: !!s.ready[id], net: s.results?.[id]?.net })),
      me: { bets: s.bets[pid] || [], lastBets: s.lastBets[pid] || [], ready: !!s.ready[pid], result: s.results?.[pid] || null },
      limits: { minSpot: MIN_SPOT, maxTotal: MAX_TOTAL },
      timing: { spin: T.spin },
    };
  }

  const stakeOf = (s, id) => (s.phase === 'betting' || s.phase === 'spinning' ? sum(s.bets[id]) : 0);

  return {
    id: 'roulette',
    name: 'Roulette',
    tagline: 'One shared wheel. Chase the 35 to 1.',
    accent: '#d4202f',
    minBet: MIN_SPOT,
    maxBet: MAX_TOTAL,
    rules: ['European single-zero wheel', '97.3% returned on every bet', 'Straight up pays 35 to 1', 'Everyone spins together'],
    init,
    tick,
    act,
    view,
    summary: (s) => ({ phase: s.phase, deadline: s.deadline, seated: Object.keys(s.bets).length, round: s.round }),
    staked: stakeOf,
    reset(s, ctx) {
      for (const id of Object.keys(s.bets)) {
        const n = stakeOf(s, id);
        if (n) ctx.credit(id, n);
      }
      const fresh = init();
      fresh.round = s.round + 1;
      fresh.history = s.history;
      return fresh;
    },
  };
}
