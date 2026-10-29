// Multiplayer Blackjack: ONE shared table. Everyone bets during a countdown, is dealt from the same
// shoe against the same dealer, then plays in seat order. The state is plain JSON so it can be saved
// to disk and resumed after a restart.
//
// Rules: 6 decks, shoe reshuffled below 25%, dealer stands on all 17s and peeks for blackjack,
// blackjack pays 3:2, double on any two cards (also after a split), split equal-value cards up to
// 4 hands (split aces get one card each), no insurance, up to 7 players per round.
//
// Engine contract (see index.js): init, tick, act, view, summary, staked, reset.
import { makeShoe, cardObj } from './cards.js';

export const DECKS = 6;
export const MIN = 10;
export const MAX = 5000;
export const MAX_SEATS = 7;
export const MAX_HANDS = 4;

export const pointValue = (n) => {
  const r = n % 13;
  return r === 0 ? 11 : r >= 9 ? 10 : r + 1;
};

export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const n of cards) {
    const v = pointValue(n);
    total += v;
    if (v === 11) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

const isNatural = (cards) => cards.length === 2 && handValue(cards).total === 21;
const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const newHand = (cards, bet, extra = {}) => ({ cards, bet, status: 'active', doubled: false, split: false, ...extra });

export function createBlackjack({ timing } = {}) {
  const T = { bet: 20_000, turn: 20_000, offlineTurn: 3_000, result: 6_500, draw: 800, ...timing };

  const init = () => ({
    phase: 'betting', // betting -> playing -> result -> betting ...
    round: 1,
    deadline: null, // epoch ms when tick() must act next (null = waiting for the first bet)
    shoe: [],
    shuffled: false,
    dealer: [],
    order: [], // player ids in seat order
    seats: {}, // id -> { bet, hands, active, ready }
    turn: null,
    lastBets: {},
    results: null, // id -> { wagered, returned, net, hands: [{result, bet, payout}] }
    dealerDraws: 0,
  });

  function startRound(s, now, ctx) {
    const ids = s.order.filter((id) => s.seats[id]?.bet > 0);
    if (!ids.length) {
      s.deadline = null;
      return;
    }
    if (s.shoe.length < DECKS * 52 * 0.25) {
      s.shoe = makeShoe(DECKS, ctx.rng);
      s.shuffled = true;
    } else s.shuffled = false;
    s.order = ids;
    s.dealer = [];
    s.results = null;
    s.dealerDraws = 0;
    for (const id of ids) {
      const seat = s.seats[id];
      seat.hands = [newHand([], seat.bet)];
      seat.active = 0;
      seat.ready = false;
      s.lastBets[id] = seat.bet;
    }
    for (const id of ids) s.seats[id].hands[0].cards.push(s.shoe.pop());
    s.dealer.push(s.shoe.pop());
    for (const id of ids) s.seats[id].hands[0].cards.push(s.shoe.pop());
    s.dealer.push(s.shoe.pop());
    s.phase = 'playing';
    const up = pointValue(s.dealer[0]);
    if ((up === 10 || up === 11) && isNatural(s.dealer)) return finishRound(s, now, ctx, true);
    for (const id of ids) for (const h of s.seats[id].hands) if (isNatural(h.cards)) h.status = 'stand';
    advance(s, now, ctx);
  }

  /** Give the turn to the next player (in seat order) who still has an active hand. */
  function advance(s, now, ctx) {
    for (const id of s.order) {
      const seat = s.seats[id];
      const i = seat.hands.findIndex((h) => h.status === 'active');
      if (i >= 0) {
        seat.active = i;
        s.turn = id;
        s.deadline = now + (ctx.online(id) ? T.turn : T.offlineTurn);
        return;
      }
    }
    s.turn = null;
    finishRound(s, now, ctx, false);
  }

  function finishRound(s, now, ctx, peeked) {
    const live =
      !peeked &&
      s.order.some((id) => s.seats[id].hands.some((h) => handValue(h.cards).total <= 21 && !(!h.split && isNatural(h.cards))));
    let draws = 0;
    if (live) {
      while (handValue(s.dealer).total < 17) {
        s.dealer.push(s.shoe.pop());
        draws++;
      }
    }
    const d = handValue(s.dealer).total;
    const dealerNatural = isNatural(s.dealer);
    const results = {};
    for (const id of s.order) {
      const seat = s.seats[id];
      let wagered = 0;
      let returned = 0;
      const tags = [];
      const hands = seat.hands.map((h) => {
        const t = handValue(h.cards).total;
        wagered += h.bet;
        const natural = !h.split && isNatural(h.cards);
        let result;
        let pay = 0;
        if (t > 21) result = 'bust';
        else if (natural && !dealerNatural) {
          result = 'blackjack';
          pay = h.bet + Math.floor(h.bet * 1.5);
          tags.push('blackjack');
        } else if (natural && dealerNatural) {
          result = 'push';
          pay = h.bet;
        } else if (dealerNatural) result = 'lose';
        else if (d > 21 || t > d) {
          result = 'win';
          pay = h.bet * 2;
          if (h.doubled) tags.push('double_win');
          if (h.split) tags.push('split_win');
        } else if (t === d) {
          result = 'push';
          pay = h.bet;
        } else result = 'lose';
        returned += pay;
        return { result, bet: h.bet, payout: pay };
      });
      if (returned) ctx.credit(id, returned);
      ctx.settle(id, { wagered, returned, tags });
      results[id] = { wagered, returned, net: returned - wagered, hands };
    }
    s.results = results;
    s.phase = 'result';
    s.turn = null;
    s.dealerDraws = draws;
    s.deadline = now + T.result + draws * T.draw;
  }

  function tick(s, now, ctx) {
    if (s.deadline == null || now < s.deadline) return false;
    if (s.phase === 'betting') {
      startRound(s, now, ctx);
      return true;
    }
    if (s.phase === 'playing') {
      const h = s.seats[s.turn]?.hands[s.seats[s.turn].active];
      if (h) h.status = 'stand'; // out of time: stand
      advance(s, now, ctx);
      return true;
    }
    if (s.phase === 'result') {
      Object.assign(s, { phase: 'betting', round: s.round + 1, dealer: [], order: [], seats: {}, results: null, turn: null, deadline: null, dealerDraws: 0 });
      return true;
    }
    return false;
  }

  function act(s, pid, a, now, ctx) {
    const type = a?.type;
    if (type === 'bet') {
      if (s.phase !== 'betting') return fail('Betting is closed. Wait for the next round.');
      const amount = a.amount;
      if (!Number.isInteger(amount) || amount < 0 || (amount > 0 && amount < MIN) || amount > MAX) return fail(`Bets run from ${MIN} to ${MAX} tokens.`);
      let seat = s.seats[pid];
      if (!seat) {
        if (amount === 0) return OK;
        if (s.order.length >= MAX_SEATS) return fail('The table is full this round.');
      }
      const diff = amount - (seat?.bet || 0);
      if (diff > 0) {
        if (ctx.balance(pid) < diff) return fail('Not enough tokens for that bet.');
        ctx.debit(pid, diff);
      } else if (diff < 0) ctx.credit(pid, -diff);
      if (amount === 0) {
        delete s.seats[pid];
        s.order = s.order.filter((x) => x !== pid);
      } else {
        if (!seat) {
          seat = s.seats[pid] = { bet: 0, hands: [], active: 0, ready: false };
          s.order.push(pid);
        }
        seat.bet = amount;
        for (const id of s.order) s.seats[id].ready = false;
      }
      if (!s.order.length) s.deadline = null;
      else if (s.deadline == null) s.deadline = now + T.bet; // first bet starts the countdown
      return OK;
    }
    if (type === 'ready') {
      if (s.phase !== 'betting' || !s.seats[pid]) return fail('Place a bet first.');
      s.seats[pid].ready = true;
      if (s.order.every((id) => s.seats[id].ready)) startRound(s, now, ctx); // everyone is ready: deal now
      return OK;
    }
    if (type === 'hit' || type === 'stand' || type === 'double' || type === 'split') {
      if (s.phase !== 'playing' || s.turn !== pid) return fail('It is not your turn.');
      const seat = s.seats[pid];
      const h = seat.hands[seat.active];
      if (type === 'hit') {
        h.cards.push(s.shoe.pop());
        const t = handValue(h.cards).total;
        if (t > 21) h.status = 'bust';
        else if (t === 21) h.status = 'stand';
      } else if (type === 'stand') h.status = 'stand';
      else if (type === 'double') {
        if (h.cards.length !== 2) return fail('You can only double on your first two cards.');
        if (ctx.balance(pid) < h.bet) return fail('Not enough tokens to double.');
        ctx.debit(pid, h.bet);
        h.bet *= 2;
        h.doubled = true;
        h.cards.push(s.shoe.pop());
        h.status = handValue(h.cards).total > 21 ? 'bust' : 'stand';
      } else {
        const can = h.cards.length === 2 && pointValue(h.cards[0]) === pointValue(h.cards[1]) && seat.hands.length < MAX_HANDS;
        if (!can) return fail('You cannot split this hand.');
        if (ctx.balance(pid) < h.bet) return fail('Not enough tokens to split.');
        ctx.debit(pid, h.bet);
        const aces = pointValue(h.cards[0]) === 11;
        const x = newHand([h.cards[0], s.shoe.pop()], h.bet, { split: true });
        const y = newHand([h.cards[1], s.shoe.pop()], h.bet, { split: true });
        for (const z of [x, y]) if (aces || handValue(z.cards).total === 21) z.status = 'stand';
        seat.hands.splice(seat.active, 1, x, y);
      }
      advance(s, now, ctx);
      return OK;
    }
    return fail('Unknown move.');
  }

  function view(s, pid, now, ctx) {
    const playing = s.phase === 'playing';
    const seats = s.order.map((id) => {
      const seat = s.seats[id];
      return {
        id,
        name: ctx.name(id),
        bet: seat.bet,
        ready: seat.ready,
        turn: s.turn === id,
        active: seat.active,
        net: s.results?.[id]?.net,
        hands: seat.hands.map((h, i) => {
          const v = handValue(h.cards);
          const r = s.results?.[id]?.hands[i];
          return { cards: h.cards.map(cardObj), total: v.total, soft: v.soft, bet: h.bet, status: h.status, doubled: h.doubled, split: h.split, result: r?.result, payout: r?.payout };
        }),
      };
    });
    const me = { seated: !!s.seats[pid], bet: s.seats[pid]?.bet || 0, lastBet: s.lastBets[pid] || 0, actions: { hit: false, stand: false, double: false, split: false } };
    if (playing && s.turn === pid) {
      const seat = s.seats[pid];
      const h = seat.hands[seat.active];
      me.actions = {
        hit: true,
        stand: true,
        double: h.cards.length === 2 && ctx.balance(pid) >= h.bet,
        split: h.cards.length === 2 && pointValue(h.cards[0]) === pointValue(h.cards[1]) && seat.hands.length < MAX_HANDS && ctx.balance(pid) >= h.bet,
      };
    }
    return {
      phase: s.phase,
      round: s.round,
      deadline: s.deadline,
      turn: s.turn,
      dealer: playing ? [cardObj(s.dealer[0]), null] : s.dealer.map(cardObj),
      dealerTotal: s.phase === 'result' ? handValue(s.dealer).total : null,
      dealerDraws: s.dealerDraws,
      shuffled: s.shuffled,
      seats,
      me,
      limits: { min: MIN, max: MAX, seats: MAX_SEATS },
      timing: { draw: T.draw },
    };
  }

  const stakeOf = (s, id) => {
    const seat = s.seats[id];
    if (!seat) return 0;
    if (s.phase === 'betting') return seat.bet;
    if (s.phase === 'playing') return seat.hands.reduce((n, h) => n + h.bet, 0);
    return 0;
  };

  return {
    id: 'blackjack',
    name: 'Blackjack',
    tagline: 'One shared table. Beat the dealer to 21.',
    accent: '#0f7a47',
    minBet: MIN,
    maxBet: MAX,
    rules: ['Up to 7 players per round', 'Blackjack pays 3 to 2', 'Dealer stands on all 17s', 'Double and split'],
    init,
    tick,
    act,
    view,
    summary: (s) => ({ phase: s.phase, deadline: s.deadline, seated: s.order.length, round: s.round }),
    staked: stakeOf,
    /** Host reset: give every stake back and start a clean table. */
    reset(s, ctx) {
      for (const id of Object.keys(s.seats)) {
        const n = stakeOf(s, id);
        if (n) ctx.credit(id, n);
      }
      const fresh = init();
      fresh.round = s.round + 1;
      fresh.shoe = s.shoe;
      return fresh;
    },
  };
}
