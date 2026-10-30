# JokerGamble

A Las Vegas style **multiplayer** casino played with free play tokens. No real money, no purchases, no cash-outs. Zero npm dependencies (Node 20+), a hand-written WebSocket server and a vanilla JS client with no build step.

## How it works

- **One shared table per game.** Blackjack and Roulette each have exactly one room that is always running. Everyone who joins plays the same hands and the same spins together.
- **Accounts are created by the host.** There is no public sign-up. The host (admin) creates each player's ID and password and has full control: set or reset passwords, add/remove/set tokens, rename, switch an account off, sign it out, delete it.
- **Static host login.** Set `ADMIN_ID` and `ADMIN_PASSWORD` in the environment. Defaults are `admin` / `JokerAdmin@2026` and the server warns loudly until you change them.
- **Everything is saved.** Accounts, balances, stats, achievements and the exact state of each table (bets, cards, shoe, wheel, countdown) are written to `DATA_DIR/casino.json` (atomic write plus a `.bak`).
- **Stop and resume.** If the server stops, tables restart exactly where they were: same cards, same bets, same time left on the clock (plus a few seconds' grace for players to reconnect). Browsers reconnect by themselves.

## Run it

```
npm start                       # http://localhost:3000
ADMIN_ID=boss ADMIN_PASSWORD='something-long' DATA_DIR=./data PORT=3000 npm start
npm test
```

Open the site, sign in with the host ID, create players on the Host console, and hand each player their ID and password.

## Table rules in this build

- **Blackjack:** 6 decks, 3:2 blackjack, dealer stands on all 17, double, split (up to 4 hands), up to 7 seats. 20s betting window that starts at the first bet (or everyone taps Deal now), 20s per turn (idle or disconnected players auto-stand quickly).
- **Roulette:** European single zero, 97.3% return, inside and outside bets. 25s betting window that starts at the first chip (or everyone taps Spin now), then one shared spin.
- Each engine is server-authoritative; the browser only draws what it is told.

## Host console (`#/admin`, after signing in as host)

Create players (with a generated password), edit tokens, reset passwords, rename, switch off/on, sign out, delete; toggle the daily bonus and fresh-start top-up for the whole house; reset a stuck table (all stakes refunded); read the activity log.

## Add a new game

1. `src/games/<id>.js` exports `createXxx(opts)` returning a table engine: `id, name, tagline, accent, minBet, maxBet, rules[]`, `init()`, `tick(state, now, ctx)`, `act(state, playerId, action, now, ctx)`, `view(state, playerId, now, ctx)`, `summary(state)`, `staked(state, playerId)`, `reset(state, ctx)`. State must be plain JSON, and `state.deadline` (epoch ms or null) is the single timer, so the room can shift it after a restart. `ctx` offers `rng, online, name, balance, debit, credit, settle`.
2. `public/games/<id>.js` (+ `.css`, `.svg`) exports `default { mount(root, { act, onRoom, meta }) }` and returns a cleanup function. `onRoom(fn)` delivers a fresh snapshot whenever the table changes.
3. Add it to `src/games/index.js`.

## Deploy on Render

`render.yaml` is included. Because state lives in a file, attach a **persistent disk** and set `DATA_DIR` to its mount path (a free instance without a disk loses saved data on every deploy). Set `ADMIN_ID` and `ADMIN_PASSWORD` as environment variables. Run a single instance only: the tables live in that process.

## Security notes

Passwords are salted scrypt hashes; sessions are random tokens (stored hashed, 30 days, signed out when the password changes or the account is switched off); logins are rate limited per IP and per ID; WebSocket origin is checked; strict CSP; every message is validated on the server and all money moves only on the server.

## Layout

```
src/        config, db (persistence), accounts, progression, ws, rooms, server, main
src/games/  blackjack.js  roulette.js  cards.js  index.js
public/     index.html, css/, js/ (core, app, admin), games/ (client tables, rules, art)
test/       casino.test.js
```
