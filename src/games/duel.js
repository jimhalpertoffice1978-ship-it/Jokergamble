// Blackjack Duel, 1 v 1, no dealer. Two players stake STAKE each and are dealt from a fresh deck.
// Your first card is hidden from your opponent. The first player hits or stands, then the second.
// Bust and you lose; otherwise the hand closest to 21 takes the pot, a natural 21 beats a normal 21,
// and equal hands push (both stakes back). Idle turns stand. State is plain JSON so a duel survives a restart.
import { makeShoe, cardObj } from './cards.js';
import { handValue, pointValue } from './blackjack.js';

export const STAKE = 100;
export const MAX_QUEUE = 20;

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const other = (s, id) => (s.seats[0] === id ? s.seats[1] : s.seats[0]);
const isNatural = (cards) => cards.length === 2 && handValue(cards).total === 21;

export function createDuel({ timing } = {}) {
  const T = { turn: 20_000, offline: 4_000, result: 8_000, idle: 120_000, deal: 1_600, ...timing };

  const init = () => ({
    phase: 'waiting', // waiting -> playing -> result -> waiting
    round: 1,
    deadline: null,
    seats: [null, null],
    queue: [],
    shoe: [],
    hands: {}, // id -> [cards]
    status: {}, // id -> active | stand | bust
    turn: null,
    outcome: null, // { winner: id|null, reason }
    pot: 0,
    first: null,
    order: [],
    history: [],
  });

  const seated = (s, id) => s.seats.includes(id);

  function deal(s, now, ctx) {
    s.shoe = makeShoe(1, ctx.rng);
    s.hands = {};
    s.status = {};
    for (const id of s.seats) s.hands[id] = [];
    for (let i = 0; i < 2; i++) for (const id of s.seats) s.hands[id].push(s.shoe.pop());
    for (const id of s.seats) s.status[id] = isNatural(s.hands[id]) ? 'stand' : 'active';
    s.phase = 'playing';
    s.outcome = null;
    s.pot = 0;
    s.turn = null;
    s.deadline = now + T.deal; // a beat for the deal animation
    s.first = s.seats[ctx.rng(2)];
    s.order = [s.first, other(s, s.first)];
    advance(s, now + T.deal, ctx, true);
  }

  /** Give the turn to the next player who still has to act, or settle the duel. */
  function advance(s, now, ctx, dealing = false) {
    const next = s.order.find((id) => s.status[id] === 'active');
    if (!next) return finish(s, now, ctx);
    s.turn = next;
    s.deadline = now + (ctx.online(next) ? T.turn : T.offline);
    void dealing;
  }

  function finish(s, now, ctx) {
    const [a, b] = s.seats;
    const val = (id) => (s.status[id] === 'bust' ? -1 : handValue(s.hands[id]).total + (isNatural(s.hands[id]) ? 0.5 : 0));
    const va = val(a);
    const vb = val(b);
    let winner = null;
    let reason = 'Equal hands: stakes returned.';
    if (va !== vb) {
      winner = va > vb ? a : b;
      const loser = other(s, winner);
      reason = s.status[loser] === 'bust' ? `${ctx.name(loser)} went bust.` : isNatural(s.hands[winner]) ? 'A natural 21 wins.' : 'Closest to 21 wins.';
    }
    const pot = STAKE * 2;
    if (winner) {
      ctx.credit(winner, pot);
      ctx.settle(winner, { wagered: STAKE, returned: pot, tags: ['duel_win'] });
      ctx.settle(other(s, winner), { wagered: STAKE, returned: 0, tags: [] });
    } else {
      for (const id of s.seats) {
        ctx.credit(id, STAKE);
        ctx.settle(id, { wagered: STAKE, returned: STAKE, tags: [] });
      }
    }
    s.outcome = { winner, reason };
    s.pot = pot;
    s.phase = 'result';
    s.turn = null;
    s.history = [{ round: s.round, a: ctx.name(a), b: ctx.name(b), winner: winner ? ctx.name(winner) : null }, ...s.history].slice(0, 8);
    s.deadline = now + T.result;
  }

  function fillSeats(s, now, ctx) {
    while (s.queue.length && s.seats.includes(null)) {
      const id = s.queue.shift();
      if (!ctx.exists(id) || seated(s, id) || ctx.balance(id) < STAKE) continue;
      ctx.debit(id, STAKE);
      s.seats[s.seats[0] === null ? 0 : 1] = id;
    }
    if (s.seats[0] && s.seats[1]) deal(s, now, ctx);
    else s.deadline = s.seats[0] || s.seats[1] ? now + T.idle : null;
  }

  function tick(s, now, ctx) {
    if (s.deadline == null || now < s.deadline) return false;
    if (s.phase === 'waiting') {
      for (const id of s.seats) if (id) ctx.credit(id, STAKE);
      s.seats = [null, null];
      s.deadline = null;
      fillSeats(s, now, ctx);
      return true;
    }
    if (s.phase === 'playing') {
      if (s.turn) s.status[s.turn] = 'stand'; // out of time: stand
      advance(s, now, ctx);
      return true;
    }
    if (s.phase === 'result') {
      Object.assign(s, { phase: 'waiting', round: s.round + 1, seats: [null, null], hands: {}, status: {}, turn: null, outcome: null, pot: 0, deadline: null });
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
    if (s.phase === 'playing') {
      // walking away mid-hand concedes the pot
      s.status[pid] = 'bust';
      const foe = other(s, pid);
      s.status[foe] = s.status[foe] === 'bust' ? 'bust' : 'stand';
      finish(s, now, ctx);
    }
    return OK;
  }

  function act(s, pid, a, now, ctx) {
    switch (a?.type) {
      case 'sit': {
        if (seated(s, pid) || s.queue.includes(pid)) return fail('You are already in line for this table.');
        if (ctx.balance(pid) < STAKE) return fail(`You need ${STAKE} tokens to take a seat.`);
        if (s.phase === 'waiting' && s.seats.includes(null)) {
          ctx.debit(pid, STAKE);
          s.seats[s.seats[0] === null ? 0 : 1] = pid;
          if (s.seats[0] && s.seats[1]) deal(s, now, ctx);
          else s.deadline = now + T.idle;
          return OK;
        }
        if (s.queue.length >= MAX_QUEUE) return fail('The queue is full.');
        s.queue.push(pid);
        return OK;
      }
      case 'leave':
      case 'resign':
        if (a.type === 'resign' && (s.phase !== 'playing' || !seated(s, pid))) return fail('Nothing to resign from.');
        return leave(s, pid, now, ctx);
      case 'hit': {
        if (s.phase !== 'playing' || s.turn !== pid) return fail('It is not your turn.');
        s.hands[pid].push(s.shoe.pop());
        const t = handValue(s.hands[pid]).total;
        if (t > 21) s.status[pid] = 'bust';
        else if (t === 21) s.status[pid] = 'stand';
        advance(s, now, ctx);
        return OK;
      }
      case 'stand':
        if (s.phase !== 'playing' || s.turn !== pid) return fail('It is not your turn.');
        s.status[pid] = 'stand';
        advance(s, now, ctx);
        return OK;
      default:
        return fail('Unknown move.');
    }
  }

  function view(s, pid, now, ctx) {
    const reveal = s.phase === 'result';
    const hands = s.seats.map((id) => {
      if (!id) return null;
      const cards = s.hands[id] || [];
      const mine = id === pid;
      const hideFirst = !mine && !reveal && cards.length > 0;
      const shown = hideFirst ? cards.slice(1) : cards;
      const v = handValue(cards);
      return {
        id,
        name: ctx.name(id),
        cards: cards.map((c, i) => (hideFirst && i === 0 ? null : cardObj(c))),
        total: mine || reveal ? v.total : null,
        soft: mine || reveal ? v.soft : false,
        showing: hideFirst ? shown.reduce((n, c) => n + pointValue(c), 0) : null, // opponent's visible points (aces count 11)
        status: mine || reveal || s.status[id] === 'bust' ? s.status[id] : s.status[id] === 'stand' ? 'stand' : 'active',
        natural: (mine || reveal) && isNatural(cards),
      };
    });
    const seat = s.seats.indexOf(pid);
    return {
      phase: s.phase,
      round: s.round,
      deadline: s.deadline,
      turn: s.turn,
      outcome: s.outcome,
      pot: s.pot,
      hands,
      queue: s.queue.map((id) => ctx.name(id)),
      history: s.history,
      me: { seat: seat < 0 ? null : seat, queued: s.queue.includes(pid), canSit: ctx.balance(pid) >= STAKE },
      limits: { stake: STAKE },
      timing: { deal: T.deal },
    };
  }

  const stakeOf = (s, id) => (seated(s, id) && s.phase !== 'result' ? STAKE : 0);

  return {
    id: 'duel',
    name: 'Blackjack Duel',
    tagline: 'No dealer. Just you, one rival and 21.',
    accent: '#8a2be2',
    minBet: STAKE,
    maxBet: STAKE,
    rules: [`${STAKE} tokens each, winner takes ${STAKE * 2}`, 'No dealer: closest to 21 wins', 'Your first card is hidden from your rival', 'Bust loses, equal hands push'],
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
