// The game registry. Every game is ONE shared table (room) that all players join together.
//
// To add a game:
//   1. src/games/<id>.js  exports createXxx(opts) returning a table engine:
//        id, name, tagline, accent, minBet, maxBet, rules[]
//        init()                                   -> fresh JSON-safe state
//        tick(state, now, ctx)                    -> true if something changed (advance timers/phases)
//        act(state, playerId, action, now, ctx)   -> { ok:true } | { ok:false, error }
//        view(state, playerId, now, ctx)          -> what that player may see (hide secrets here)
//        summary(state)                           -> { phase, deadline, seated } for the lobby
//        staked(state, playerId)                  -> tokens currently on the table for that player
//        reset(state, ctx)                        -> new state after refunding every stake
//      `state.deadline` (epoch ms or null) is the next time tick() must act; the room shifts it
//      automatically when the server restarts, so rounds resume with the same time left.
//      ctx gives: rng(n), now, online(id), name(id), balance(id), debit(id,n), credit(id,n),
//      settle(id, {wagered, returned, tags}) which updates stats, XP and achievements.
//   2. public/games/<id>.js (+ .css, .svg): the table UI (see blackjack.js).
//   3. Add it to the list below.
import { createBlackjack } from './blackjack.js';
import { createRoulette } from './roulette.js';
import { createLottery } from './lottery.js';

export const defaultGames = (opts = {}) => [createBlackjack(opts.blackjack), createRoulette(opts.roulette), createLottery(opts.lottery)];
