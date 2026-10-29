// Lucky Draw: ONE shared lottery. Everyone picks 5 numbers from 1-36 on tickets, the clock runs out,
// five balls are drawn for the whole room and every ticket is paid at once. Match 5 for the progressive jackpot.
// State is plain JSON so a half-finished draw survives a server restart.

export const POOL = 36;
export const PICKS = 5;
export const PRICE = 20;
export const MAX_TICKETS = 10;
export const JACKPOT_SEED = 50_000;
export const JACKPOT_CUT = 5; // tokens of every ticket that feed the jackpot
export const PRIZE = { 2: 40, 3: 400, 4: 10_000 }; // fixed prizes; 5 matches shares the jackpot

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

export const matches = (nums, drawn) => nums.filter((n) => drawn.includes(n)).length;

export function createLottery({ timing } = {}) {
  const T = { sell: 45_000, draw: 8_000, result: 7_000, ...timing };

  const init = () => ({
    phase: 'selling', // selling -> drawing -> result -> selling ...
    round: 1,
    deadline: null, // the first ticket of a round starts the clock
    tickets: {}, // id -> [[n x5], ...]
    drawn: null,
    jackpot: JACKPOT_SEED,
    results: null, // id -> { wagered, returned, net, tickets: [{nums, hits, prize}] }
    lastTickets: {},
    history: [], // [{round, drawn, jackpotWon}]
  });

  const count = (s) => Object.values(s.tickets).reduce((n, t) => n + t.length, 0);

  function draw(s, now, ctx) {
    const balls = Array.from({ length: POOL }, (_, i) => i + 1);
    const drawn = [];
    for (let i = 0; i < PICKS; i++) drawn.push(balls.splice(ctx.rng(balls.length), 1)[0]);
    s.drawn = drawn; // order matters for the reveal; matching ignores it
    s.jackpot += JACKPOT_CUT * count(s);
    s.phase = 'drawing';
    s.deadline = now + T.draw;
  }

  function settle(s, now, ctx) {
    const rows = {};
    let winners = 0;
    for (const [id, list] of Object.entries(s.tickets)) {
      rows[id] = list.map((nums) => ({ nums, hits: matches(nums, s.drawn) }));
      winners += rows[id].filter((t) => t.hits === 5).length;
    }
    const share = winners ? Math.floor(s.jackpot / winners) : 0;
    const results = {};
    for (const [id, list] of Object.entries(rows)) {
      let returned = 0;
      const tickets = list.map((t) => {
        const prize = t.hits === 5 ? share : PRIZE[t.hits] || 0;
        returned += prize;
        return { ...t, prize };
      });
      const wagered = list.length * PRICE;
      if (returned) ctx.credit(id, returned);
      ctx.settle(id, { wagered, returned, tags: list.some((t) => t.hits === 5) ? ['jackpot'] : [] });
      results[id] = { wagered, returned, net: returned - wagered, tickets };
      s.lastTickets[id] = s.tickets[id];
    }
    s.history = [{ round: s.round, drawn: s.drawn, jackpotWon: winners ? s.jackpot : 0 }, ...s.history].slice(0, 10);
    if (winners) s.jackpot = JACKPOT_SEED;
    s.results = results;
    s.phase = 'result';
    s.deadline = now + T.result;
  }

  function tick(s, now, ctx) {
    if (s.deadline == null || now < s.deadline) return false;
    if (s.phase === 'selling') {
      if (count(s)) draw(s, now, ctx);
      else s.deadline = null;
      return true;
    }
    if (s.phase === 'drawing') {
      settle(s, now, ctx);
      return true;
    }
    if (s.phase === 'result') {
      Object.assign(s, { phase: 'selling', round: s.round + 1, tickets: {}, drawn: null, results: null, deadline: null });
      return true;
    }
    return false;
  }

  function clean(list) {
    if (!Array.isArray(list) || list.length > MAX_TICKETS) return null;
    const out = [];
    for (const t of list) {
      if (!Array.isArray(t) || t.length !== PICKS || !t.every((n) => Number.isInteger(n) && n >= 1 && n <= POOL) || new Set(t).size !== PICKS) return null;
      out.push([...t].sort((a, b) => a - b));
    }
    return out;
  }

  function act(s, pid, a, now, ctx) {
    if (a?.type !== 'setTickets') return fail('Unknown move.');
    if (s.phase !== 'selling') return fail('The draw has started. Tickets are closed.');
    const list = clean(a.tickets);
    if (!list) return fail(`Pick ${PICKS} different numbers from 1 to ${POOL} on each ticket (up to ${MAX_TICKETS} tickets).`);
    const diff = (list.length - (s.tickets[pid]?.length || 0)) * PRICE;
    if (diff > 0) {
      if (ctx.balance(pid) < diff) return fail('Not enough tokens for those tickets.');
      ctx.debit(pid, diff);
    } else if (diff < 0) ctx.credit(pid, -diff);
    if (list.length) s.tickets[pid] = list;
    else delete s.tickets[pid];
    if (!count(s)) s.deadline = null;
    else if (s.deadline == null) s.deadline = now + T.sell; // the first ticket starts the countdown
    return OK;
  }

  function view(s, pid, now, ctx) {
    const shown = s.phase === 'drawing' || s.phase === 'result';
    return {
      phase: s.phase,
      round: s.round,
      deadline: s.deadline,
      drawn: shown ? s.drawn : null,
      jackpot: s.jackpot + (s.phase === 'selling' ? JACKPOT_CUT * count(s) : 0),
      history: s.history,
      players: Object.keys(s.tickets).map((id) => ({ id, name: ctx.name(id), count: s.tickets[id].length, net: s.results?.[id]?.net })),
      me: { tickets: s.tickets[pid] || [], lastTickets: s.lastTickets[pid] || [], result: s.results?.[pid] || null },
      limits: { pool: POOL, picks: PICKS, price: PRICE, maxTickets: MAX_TICKETS },
      prizes: { ...PRIZE, 5: 'Jackpot' },
      timing: { draw: T.draw },
    };
  }

  const stakeOf = (s, id) => (s.phase === 'selling' || s.phase === 'drawing' ? (s.tickets[id]?.length || 0) * PRICE : 0);

  return {
    id: 'lottery',
    name: 'Lucky Draw',
    tagline: 'One shared draw. Five numbers, one jackpot.',
    accent: '#f6c744',
    minBet: PRICE,
    maxBet: PRICE * MAX_TICKETS,
    rules: [`Pick ${PICKS} numbers from 1 to ${POOL}`, `${PRICE} tokens a ticket, up to ${MAX_TICKETS}`, 'Match 2, 3 or 4 for fixed prizes', 'Match all 5 for the rolling jackpot'],
    init,
    tick,
    act,
    view,
    summary: (s) => ({ phase: s.phase, deadline: s.deadline, seated: Object.keys(s.tickets).length, round: s.round, jackpot: s.jackpot }),
    staked: stakeOf,
    reset(s, ctx) {
      for (const id of Object.keys(s.tickets)) {
        const n = stakeOf(s, id);
        if (n) ctx.credit(id, n);
      }
      const fresh = init();
      fresh.round = s.round + 1;
      fresh.history = s.history;
      fresh.jackpot = s.jackpot;
      return fresh;
    },
  };
}
