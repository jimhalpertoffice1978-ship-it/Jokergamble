// Battleship, 1 v 1. ONE shared table with two seats; everyone else watches or joins the queue.
// Both players stake STAKE tokens, place a fleet (60s, auto-placed if they run out of time), then take
// turns firing. The winner takes the whole pot. All state is plain JSON, so a match in progress
// survives a server restart (the single `deadline` is shifted by the room).

export const SIZE = 10;
export const FLEET = [
  { name: 'Carrier', len: 5 },
  { name: 'Battleship', len: 4 },
  { name: 'Cruiser', len: 3 },
  { name: 'Submarine', len: 3 },
  { name: 'Destroyer', len: 2 },
];
export const STAKE = 100;
export const MAX_QUEUE = 20;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const other = (s, id) => (s.seats[0] === id ? s.seats[1] : s.seats[0]);

/** Validate a fleet like [{x,y,dir:'h'|'v',len}] and return ships with cells, or null. */
export function buildFleet(list) {
  if (!Array.isArray(list) || list.length !== FLEET.length) return null;
  const want = FLEET.map((f) => f.len).sort().join();
  if (list.map((l) => l?.len).sort().join() !== want) return null;
  const used = new Set();
  const placed = [];
  for (const l of list) {
    if (!l || !Number.isInteger(l.x) || !Number.isInteger(l.y) || (l.dir !== 'h' && l.dir !== 'v')) return null;
    const cells = [];
    for (let k = 0; k < l.len; k++) {
      const x = l.x + (l.dir === 'h' ? k : 0);
      const y = l.y + (l.dir === 'v' ? k : 0);
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return null;
      const c = y * SIZE + x;
      if (used.has(c)) return null;
      used.add(c);
      cells.push(c);
    }
    placed.push({ len: l.len, cells });
  }
  placed.sort((a, b) => b.len - a.len);
  return placed.map((p, i) => ({ name: FLEET[i].name, len: p.len, cells: p.cells }));
}

export function randomFleet(rng) {
  for (;;) {
    const used = new Set();
    const list = [];
    let ok = true;
    for (const f of FLEET) {
      let done = false;
      for (let tries = 0; tries < 200 && !done; tries++) {
        const dir = rng(2) ? 'h' : 'v';
        const x = rng(SIZE - (dir === 'h' ? f.len - 1 : 0));
        const y = rng(SIZE - (dir === 'v' ? f.len - 1 : 0));
        const cells = Array.from({ length: f.len }, (_, k) => (y + (dir === 'v' ? k : 0)) * SIZE + x + (dir === 'h' ? k : 0));
        if (cells.some((c) => used.has(c))) continue;
        cells.forEach((c) => used.add(c));
        list.push({ x, y, dir, len: f.len });
        done = true;
      }
      if (!done) ok = false;
    }
    if (ok) return buildFleet(list);
  }
}

export function createBattleship({ timing } = {}) {
  const T = { place: 60_000, turn: 20_000, offline: 4_000, result: 8_000, idle: 120_000, ...timing };

  const init = () => ({
    phase: 'waiting', // waiting -> placing -> battle -> result -> waiting
    round: 1,
    deadline: null,
    seats: [null, null],
    queue: [],
    boards: {}, // id -> { ships:[{name,len,cells}], shots:[cell,...] }  (shots = cells fired AT this board)
    ready: {},
    turn: null,
    last: null, // { by, cell, hit, sunk }
    winner: null,
    pot: 0,
    history: [], // [{round, winner, loser, pot}]
  });

  const seated = (s, id) => s.seats.includes(id);

  function startPlacing(s, now) {
    s.phase = 'placing';
    s.boards = {};
    s.ready = {};
    s.deadline = now + T.place;
  }

  function fillSeats(s, now, ctx) {
    while (s.queue.length && s.seats.includes(null)) {
      const id = s.queue.shift();
      if (!ctx.exists(id) || seated(s, id) || ctx.balance(id) < STAKE) continue;
      ctx.debit(id, STAKE);
      s.seats[s.seats[0] === null ? 0 : 1] = id;
    }
    if (s.seats[0] && s.seats[1]) startPlacing(s, now);
    else s.deadline = s.seats[0] || s.seats[1] ? now + T.idle : null;
  }

  function startBattle(s, now, ctx) {
    for (const id of s.seats) if (!s.boards[id]) s.boards[id] = { ships: randomFleet(ctx.rng), shots: [] };
    s.phase = 'battle';
    s.turn = s.seats[ctx.rng(2)];
    s.last = null;
    s.deadline = now + (ctx.online(s.turn) ? T.turn : T.offline);
  }

  function finish(s, winner, now, ctx) {
    const loser = other(s, winner);
    const pot = STAKE * 2;
    ctx.credit(winner, pot);
    ctx.settle(winner, { wagered: STAKE, returned: pot, tags: ['battleship_win'] });
    ctx.settle(loser, { wagered: STAKE, returned: 0, tags: [] });
    s.winner = winner;
    s.pot = pot;
    s.phase = 'result';
    s.turn = null;
    s.history = [{ round: s.round, winner: ctx.name(winner), loser: ctx.name(loser), pot }, ...s.history].slice(0, 8);
    s.deadline = now + T.result;
  }

  function shoot(s, pid, cell, now, ctx) {
    const foe = other(s, pid);
    const board = s.boards[foe];
    board.shots.push(cell);
    const ship = board.ships.find((sh) => sh.cells.includes(cell));
    const sunk = ship && ship.cells.every((c) => board.shots.includes(c)) ? { name: ship.name, len: ship.len } : null;
    s.last = { by: pid, cell, hit: !!ship, sunk };
    if (board.ships.every((sh) => sh.cells.every((c) => board.shots.includes(c)))) return finish(s, pid, now, ctx);
    s.turn = foe;
    s.deadline = now + (ctx.online(foe) ? T.turn : T.offline);
  }

  function tick(s, now, ctx) {
    if (s.deadline == null || now < s.deadline) return false;
    if (s.phase === 'waiting') {
      // a lone player nobody joined: give the stake back and free the seat
      for (const id of s.seats) if (id) ctx.credit(id, STAKE);
      s.seats = [null, null];
      s.deadline = null;
      fillSeats(s, now, ctx);
      return true;
    }
    if (s.phase === 'placing') {
      startBattle(s, now, ctx);
      return true;
    }
    if (s.phase === 'battle') {
      // out of time: fire at a random untouched cell for them
      const foe = other(s, s.turn);
      const fired = new Set(s.boards[foe].shots);
      const open = Array.from({ length: SIZE * SIZE }, (_, i) => i).filter((c) => !fired.has(c));
      shoot(s, s.turn, open[ctx.rng(open.length)], now, ctx);
      return true;
    }
    if (s.phase === 'result') {
      Object.assign(s, { phase: 'waiting', round: s.round + 1, seats: [null, null], boards: {}, ready: {}, turn: null, last: null, winner: null, pot: 0, deadline: null });
      fillSeats(s, now, ctx);
      return true;
    }
    return false;
  }

  function leave(s, pid, now, ctx) {
    s.queue = s.queue.filter((q) => q !== pid);
    if (!seated(s, pid)) return OK;
    if (s.phase === 'waiting') {
      s.seats[s.seats.indexOf(pid)] = null;
      ctx.credit(pid, STAKE);
      s.deadline = s.seats[0] || s.seats[1] ? now + T.idle : null;
      return OK;
    }
    if (s.phase === 'placing') {
      // nothing was fired yet: refund the leaver, the other player keeps their seat and waits
      s.seats[s.seats.indexOf(pid)] = null;
      ctx.credit(pid, STAKE);
      Object.assign(s, { phase: 'waiting', boards: {}, ready: {}, deadline: now + T.idle });
      return OK;
    }
    if (s.phase === 'battle') return finish(s, other(s, pid), now, ctx), OK; // resigning concedes the pot
    return OK; // result: nothing to do, the seats clear themselves
  }

  function act(s, pid, a, now, ctx) {
    switch (a?.type) {
      case 'sit': {
        if (seated(s, pid) || s.queue.includes(pid)) return fail('You are already in line for this table.');
        if (ctx.balance(pid) < STAKE) return fail(`You need ${STAKE} tokens to take a seat.`);
        if (s.phase === 'waiting' && s.seats.includes(null)) {
          ctx.debit(pid, STAKE);
          s.seats[s.seats[0] === null ? 0 : 1] = pid;
          if (s.seats[0] && s.seats[1]) startPlacing(s, now);
          else s.deadline = now + T.idle;
          return OK;
        }
        if (s.queue.length >= MAX_QUEUE) return fail('The queue is full.');
        s.queue.push(pid);
        return OK;
      }
      case 'leave':
        return leave(s, pid, now, ctx);
      case 'resign':
        if (s.phase !== 'battle' || !seated(s, pid)) return fail('Nothing to resign from.');
        return leave(s, pid, now, ctx);
      case 'place': {
        if (s.phase !== 'placing' || !seated(s, pid)) return fail('You cannot place ships right now.');
        if (s.ready[pid]) return fail('Your fleet is locked in.');
        const ships = buildFleet(a.ships);
        if (!ships) return fail('That fleet does not fit. Ships must stay on the grid and not overlap.');
        s.boards[pid] = { ships, shots: [] };
        return OK;
      }
      case 'random':
        if (s.phase !== 'placing' || !seated(s, pid)) return fail('You cannot place ships right now.');
        if (s.ready[pid]) return fail('Your fleet is locked in.');
        s.boards[pid] = { ships: randomFleet(ctx.rng), shots: [] };
        return OK;
      case 'ready':
        if (s.phase !== 'placing' || !seated(s, pid)) return fail('Not now.');
        if (!s.boards[pid]) return fail('Place all five ships first.');
        s.ready[pid] = true;
        if (s.seats.every((id) => s.ready[id])) startBattle(s, now, ctx);
        return OK;
      case 'fire': {
        if (s.phase !== 'battle') return fail('The battle is not on.');
        if (s.turn !== pid) return fail('Hold your fire: it is not your turn.');
        const c = a.cell;
        if (!Number.isInteger(c) || c < 0 || c >= SIZE * SIZE) return fail('Pick a square on the grid.');
        if (s.boards[other(s, pid)].shots.includes(c)) return fail('You already fired there.');
        shoot(s, pid, c, now, ctx);
        return OK;
      }
      default:
        return fail('Unknown move.');
    }
  }

  function view(s, pid, now, ctx) {
    const reveal = s.phase === 'result';
    const boards = s.seats.map((id) => {
      if (!id) return null;
      const b = s.boards[id];
      const shots = b ? b.shots.map((c) => ({ c, hit: b.ships.some((sh) => sh.cells.includes(c)) })) : [];
      const sunk = b ? b.ships.filter((sh) => sh.cells.every((c) => b.shots.includes(c))).map(({ name, len, cells }) => ({ name, len, cells })) : [];
      return { id, name: ctx.name(id), ready: !!s.ready[id], placed: !!b, shots, sunk, ships: b && (id === pid || reveal) ? b.ships : null };
    });
    const seat = s.seats.indexOf(pid);
    return {
      phase: s.phase,
      round: s.round,
      deadline: s.deadline,
      turn: s.turn,
      last: s.last,
      winner: s.winner,
      pot: s.pot,
      boards,
      queue: s.queue.map((id) => ctx.name(id)),
      history: s.history,
      me: { seat: seat < 0 ? null : seat, queued: s.queue.includes(pid), canSit: ctx.balance(pid) >= STAKE },
      limits: { size: SIZE, stake: STAKE, fleet: FLEET },
    };
  }

  const stakeOf = (s, id) => (seated(s, id) && s.phase !== 'result' ? STAKE : 0);

  return {
    id: 'battleship',
    name: 'Battleship',
    tagline: 'Head to head. Sink the fleet, take the pot.',
    accent: '#2b7fd4',
    minBet: STAKE,
    maxBet: STAKE,
    rules: [`${STAKE} tokens each, winner takes ${STAKE * 2}`, 'Two players, everyone else can watch', 'Hide five ships, then take turns firing', 'Idle turns fire for you, so the game never stalls'],
    init,
    tick,
    act,
    view,
    summary: (s) => ({ phase: s.phase, deadline: s.deadline, seated: s.seats.filter(Boolean).length, round: s.round, queue: s.queue.length }),
    staked: stakeOf,
    reset(s, ctx) {
      for (const id of s.seats) if (id && s.phase !== 'result') ctx.credit(id, STAKE);
      const fresh = init();
      fresh.round = s.round + 1;
      fresh.history = s.history;
      return fresh;
    },
  };
}
