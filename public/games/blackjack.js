// Shared Blackjack table. One dealer, up to 7 seats, everybody plays the same shoe.
// The server runs the clock and every decision; this file draws what it is told and sends your moves.
import { app, h, svg, fmt, signed, sleep, sfx, chip, chipsFor, chipTray, releaseBalance, celebrate, floatText, toast, rebuy, onProfile, secsLeft } from '../js/core.js';

const GLYPH = { S: '♠︎', H: '♥︎', D: '♦︎', C: '♣︎' };
const LABEL = { win: 'Win', blackjack: 'Blackjack', push: 'Push', lose: 'Lose', bust: 'Bust' };
const isRed = (s) => s === 'H' || s === 'D';

function cardEl(c, { enter = false, reveal = false, delay = 0 } = {}) {
  const el = c
    ? h(
        'div',
        { class: `pc ${isRed(c.suit) ? 'red' : ''}`, 'aria-label': `${c.rank} of ${c.suit}` },
        h('span', { class: 'r tl' }, c.rank, h('i', null, GLYPH[c.suit])),
        h('span', { class: 'pip' }, GLYPH[c.suit]),
        h('span', { class: 'r br' }, c.rank, h('i', null, GLYPH[c.suit])),
      )
    : h('div', { class: 'pc back', 'aria-label': 'Hidden card' });
  if (enter) el.classList.add('enter');
  if (reveal) el.classList.add('reveal');
  if (enter || reveal) el.style.setProperty('--d', `${delay}s`);
  return el;
}

const totalLabel = (hd) => (hd.total > 21 ? 'Bust' : `${hd.soft && hd.total < 21 ? 'Soft ' : ''}${hd.total}`);

export default {
  async mount(root, { act, onRoom }) {
    let alive = true;
    let view = null;
    let prev = null;
    let bet = 0; // what I want on the table (kept locally while the server catches up)
    let sent = 0;
    let inflight = false;
    let anim = 0; // token that cancels an older reveal when a newer snapshot arrives
    let revealing = false;

    const dealerCards = h('div', { class: 'bj-cards' });
    const dealerTotal = h('div', { class: 'bj-total' });
    const seatsEl = h('div', { class: 'bj-seats' });
    const banner = h('div', { class: 'bj-banner', role: 'status' });
    const timer = h('div', { class: 'bj-timer', role: 'timer' });
    const felt = h(
      'div',
      { class: 'felt bj-felt' },
      h('div', { class: 'bj-print' }, 'Blackjack pays 3 to 2', h('br'), 'Dealer stands on all 17'),
      h('div', { class: 'bj-zone' }, h('div', { class: 'bj-label' }, 'Dealer'), dealerCards, dealerTotal),
      h('div', { class: 'bj-mid' }, banner, timer),
      seatsEl,
    );

    /* ---- betting panel ---- */
    const spotStack = h('div', { class: 'stack' });
    const spotAmt = h('div', { class: 'bj-spotamt' });
    const tray = chipTray({ onPick: (v) => setBet(bet + v) });
    const mkBtn = (label, fn) => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { sfx.chip(); fn(); } }, label);
    const btnClear = mkBtn('Clear', () => setBet(0));
    const btnRebet = mkBtn('Last bet', () => setBet(view.me.lastBet));
    const btnDouble = mkBtn('x2', () => setBet(bet * 2));
    const btnMax = mkBtn('Max', () => setBet(Infinity));
    const btnDeal = h('button', { class: 'btn btn-green btn-lg bj-deal', type: 'button', onclick: () => ready() });
    const betPanel = h('div', { class: 'bj-bet-panel' }, h('div', { class: 'bj-spotwrap' }, h('div', { class: 'bj-spot' }, spotStack), spotAmt), tray.el, h('div', { class: 'bj-adjust' }, btnClear, btnRebet, btnDouble, btnMax), btnDeal, h('div', { class: 'bj-hint' }, 'Everyone at the table is dealt together. Space to deal now.'));

    const broke = h('div', { class: 'bj-broke' }, h('h3', null, 'Out of tokens!'), h('p', null, 'Even the best players hit a cold streak. The house will front you a fresh stack.'), h('button', { class: 'btn btn-red btn-lg', type: 'button', onclick: () => rebuy() }, `Fresh start +${app.meta.rebuy}`));

    /* ---- play panel ---- */
    const mk = (type, label, key, cls = '') => h('button', { class: `btn btn-lg ${cls}`, type: 'button', dataset: { act: type }, onclick: () => move(type) }, label, h('small', null, key));
    const playPanel = h('div', { class: 'bj-actions' }, mk('hit', 'Hit', 'H', 'btn-green'), mk('stand', 'Stand', 'S', 'btn-red'), mk('double', 'Double', 'D'), mk('split', 'Split', 'P'));
    const waitPanel = h('div', { class: 'bj-wait' });

    root.append(felt, h('div', { class: 'bj-controls' }, betPanel, broke, playPanel, waitPanel));

    /* ---- betting ---- */
    const maxBet = () => Math.min(view.limits.max, app.profile.balance + sent);
    function setBet(n) {
      if (!view || view.phase !== 'betting') return;
      const v = Math.max(0, Math.min(Math.floor(Number.isFinite(n) ? n : maxBet()), maxBet()));
      if (v > 0 && v < view.limits.min) bet = view.limits.min;
      else bet = v;
      paintControls();
      push();
    }
    async function push() {
      if (inflight) return;
      inflight = true;
      while (alive && bet !== sent) {
        const want = bet;
        const r = await act({ type: 'bet', amount: want });
        if (!r.ok) {
          toast(r.error || 'The dealer could not take that bet.', 'bad');
          bet = view?.me.bet ?? 0;
          sent = bet;
          break;
        }
        sent = want;
      }
      inflight = false;
      paintControls();
    }
    async function ready() {
      if (!view || view.phase !== 'betting' || !bet) return;
      if (bet !== sent) await push();
      const r = await act({ type: 'ready' });
      if (!r.ok) toast(r.error || 'Not yet.', 'bad');
      sfx.click();
    }
    async function move(type) {
      if (!view?.me.actions[type]) return;
      for (const b of playPanel.querySelectorAll('button')) b.disabled = true;
      const r = await act({ type });
      if (!r.ok) {
        toast(r.error || 'That move did not work.', 'bad');
        paintControls();
      }
    }

    function paintControls() {
      if (!view) return;
      const { phase, me } = view;
      const betting = phase === 'betting';
      const myTurn = phase === 'playing' && view.turn === app.profile.id;
      const isBroke = betting && !bet && me.bet === 0 && app.profile.canRebuy;
      betPanel.hidden = !betting || isBroke;
      broke.hidden = !isBroke;
      playPanel.hidden = !myTurn;
      waitPanel.hidden = betting || myTurn;
      if (!waitPanel.hidden) {
        const who = view.seats.find((s) => s.turn);
        waitPanel.textContent = phase === 'playing' ? (who ? `${who.name} is deciding...` : 'Dealer is playing...') : me.seated ? 'Settling up...' : 'Next round: place your bet when betting opens.';
      }
      if (betting) {
        spotStack.replaceChildren(...chipsFor(bet).slice(0, 9).reverse().map((v) => chip(v)));
        [...spotStack.children].forEach((c, i, all) => (c.style.transform = `translateY(${(all.length - 1 - i) * 5}px)`));
        spotAmt.textContent = bet ? fmt(bet) : 'Place your bet';
        const readyN = view.seats.filter((s) => s.ready).length;
        btnDeal.disabled = !bet || me.ready;
        btnDeal.textContent = me.ready ? `Waiting for others (${readyN}/${view.seats.length})` : bet ? `Deal now  ${fmt(bet)}` : 'Place a bet';
        btnClear.disabled = !bet;
        btnRebet.disabled = !me.lastBet || me.lastBet === bet || me.lastBet > maxBet();
        btnDouble.disabled = !bet || bet * 2 > maxBet();
        btnMax.disabled = bet === maxBet();
        tray.el.querySelectorAll('button').forEach((b) => (b.disabled = me.ready));
      }
      for (const b of playPanel.querySelectorAll('button')) b.disabled = !me.actions[b.dataset.act];
    }

    /* ---- the table ---- */
    function seatEl(s, ps, animate, startNew, extraDelay = 0) {
      const mine = s.id === app.profile.id;
      let k = 0;
      const hands = s.hands.map((hd, hi) => {
        const pHand = ps?.hands[hi];
        const split = ps && ps.hands.length !== s.hands.length;
        let lastCard = 0;
        const cards = hd.cards.map((c, ci) => {
          const isNew = animate && (startNew || (split ? ci >= 1 : ci >= (pHand?.cards.length ?? 0)));
          if (!isNew) return cardEl(c);
          const d = startNew ? ci * 0.44 + extraDelay : k++ * 0.4;
          lastCard = d;
          sfx && setTimeout(() => alive && sfx.card(), d * 1000 + 60);
          return cardEl(c, { enter: true, delay: d });
        });
        const active = view.phase === 'playing' && s.turn && s.active === hi && s.hands.length > 1;
        const tot = h('div', { class: `bj-total ${hd.total > 21 ? 'bust' : ''}` }, totalLabel(hd));
        tot.style.setProperty('--d', `${lastCard + 0.35}s`);
        return h(
          'div',
          { class: `bj-hand ${active ? 'active' : ''}` },
          hd.result ? h('div', { class: `bj-res ${hd.result}`, dataset: { late: '1' } }, LABEL[hd.result]) : null,
          h('div', { class: 'bj-cards' }, cards),
          tot,
          h('div', { class: 'bj-bet' }, chip(chipsFor(hd.bet)[0] ?? 10), fmt(hd.bet), hd.doubled ? h('em', null, 'doubled') : null),
        );
      });
      const showBet = view.phase === 'betting';
      return h(
        'div',
        { class: `bj-seat ${mine ? 'mine' : ''} ${s.turn ? 'turn' : ''}` },
        h('div', { class: 'bj-name' }, mine ? 'You' : s.name, s.ready && showBet ? h('i', { class: 'tick', title: 'Ready' }, '✓') : null),
        showBet ? h('div', { class: 'bj-seatbet' }, chip(chipsFor(s.bet)[0] ?? 10), fmt(s.bet)) : h('div', { class: 'bj-hands' }, hands),
        view.phase === 'result' && s.net != null ? h('div', { class: `bj-net ${s.net > 0 ? 'up' : s.net < 0 ? 'down' : ''}`, dataset: { late: '1' } }, s.net === 0 ? 'Push' : signed(s.net)) : null,
      );
    }

    /** Draw the whole table from the latest view. Returns ms until the animation finishes. */
    function render(animate) {
      const startNew = animate && view.phase === 'playing' && (!prev || prev.phase !== 'playing');
      const finishing = animate && view.phase === 'result' && prev?.phase === 'playing';
      const instantEnd = animate && view.phase === 'result' && prev && prev.phase !== 'playing'; // dealer natural: dealt and resolved at once
      let end = 0;

      let dealerDelay = 0;
      if (startNew) end = 0.44 * (view.seats.length ? 2 : 0) + 0.8;
      seatsEl.replaceChildren(
        ...[...view.seats]
          .sort((a, b) => (a.id === app.profile.id ? -1 : b.id === app.profile.id ? 1 : 0))
          .map((s) => seatEl(s, prev?.seats.find((x) => x.id === s.id), animate, startNew || instantEnd, 0)),
      );

      dealerCards.replaceChildren(
        ...(view.dealer.length ? [] : [h('div', { class: 'pc ghost' }), h('div', { class: 'pc ghost' })]),
        ...view.dealer.map((c, i) => {
          if (startNew) return cardEl(c, { enter: true, delay: 0.22 + i * 0.44 });
          if (instantEnd) return cardEl(c, i === 1 ? { reveal: true, delay: 0.8 } : { enter: true, delay: 0.22 });
          if (finishing) {
            const was = prev.dealer[i];
            if (was === null && c) {
              dealerDelay = 0.3;
              return cardEl(c, { reveal: true, delay: 0.3 });
            }
            if (!was) {
              dealerDelay += view.timing.draw / 1000;
              return cardEl(c, { enter: true, delay: dealerDelay });
            }
          }
          return cardEl(c);
        }),
      );
      dealerTotal.textContent = '';
      if (finishing || instantEnd) end = Math.max(end, dealerDelay + 0.9, instantEnd ? 1.4 : 0);
      return end * 1000;
    }

    function showResults() {
      seatsEl.querySelectorAll('[data-late]').forEach((el) => el.classList.add('show'));
      dealerTotal.textContent = view.dealerTotal > 21 ? 'Bust' : String(view.dealerTotal ?? '');
      const me = view.seats.find((s) => s.id === app.profile.id);
      if (!me || me.net == null) return;
      const hasBJ = me.hands.some((x) => x.result === 'blackjack');
      const bust = me.hands.every((x) => x.result === 'bust');
      const title = hasBJ ? 'Blackjack!' : me.net > 0 ? 'You win' : me.net < 0 ? (bust ? 'Bust' : 'Dealer wins') : 'Push';
      banner.className = `bj-banner show ${me.net > 0 ? 'win' : me.net < 0 ? 'lose' : 'push'}`;
      banner.replaceChildren(h('b', null, title), h('span', null, me.net === 0 ? 'Bet returned' : `${signed(me.net)} tokens`));
    }

    async function celebrateResult() {
      const me = view.seats.find((s) => s.id === app.profile.id);
      if (!me || me.net == null) return;
      const wagered = me.hands.reduce((n, x) => n + x.bet, 0);
      const anchor = seatsEl.querySelector('.bj-seat.mine') || felt;
      if (me.net > 0) celebrate(me.net, wagered, anchor);
      else if (me.net < 0) {
        sfx.lose();
        felt.classList.remove('shake');
        void felt.offsetWidth;
        felt.classList.add('shake');
      } else sfx.push();
      if (me.net !== 0) floatText(anchor, signed(me.net), me.net < 0 ? 'neg' : '');
    }

    function clearBanner() {
      banner.className = 'bj-banner';
      banner.replaceChildren();
    }

    async function onSnap(snap) {
      if (!alive) return;
      const nv = snap.view;
      const roundChanged = !view || nv.round !== view.round;
      prev = view;
      view = nv;
      const my = ++anim;

      if (roundChanged || nv.phase === 'betting') {
        if (roundChanged) clearBanner();
        if (!inflight) {
          bet = nv.me.bet;
          sent = nv.me.bet;
        }
      }
      const mySeat = nv.seats.find((s) => s.id === app.profile.id);
      const resultNew = nv.phase === 'result' && prev && prev.phase !== 'result';
      if (resultNew && mySeat) app.hold = true; // keep the balance still until the dealer finishes

      const first = !prev;
      const dur = render(!first);
      paintControls();
      timerPaint();
      if (nv.phase === 'result') {
        if (first || !resultNew) {
          showResults();
          if (!first) releaseBalance();
        } else {
          revealing = true;
          await sleep(dur + 200);
          revealing = false;
          if (!alive || my !== anim) {
            releaseBalance();
            return;
          }
          showResults();
          celebrateResult();
          releaseBalance();
        }
      } else if (app.hold) releaseBalance();
      if (nv.shuffled && nv.phase === 'playing' && !first) toast('The dealer shuffled a fresh shoe.');
    }

    function timerPaint() {
      if (!view) return;
      const s = secsLeft(view.deadline);
      const mine = view.turn === app.profile.id;
      let text = '';
      if (view.phase === 'betting') text = view.deadline ? `Cards in ${s}s` : view.seats.length ? '' : 'Waiting for the first bet';
      else if (view.phase === 'playing') text = mine ? `Your move: ${s}s` : '';
      else if (view.phase === 'result') text = revealing ? '' : 'Next round soon';
      timer.textContent = text;
      timer.classList.toggle('urgent', s != null && s <= 5 && (view.phase === 'betting' || mine));
    }
    const tid = setInterval(timerPaint, 250);

    function onKey(e) {
      if (e.target.matches?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey || !view) return;
      const k = e.key.toLowerCase();
      if (view.phase === 'playing') {
        const m = { h: 'hit', s: 'stand', d: 'double', p: 'split' }[k];
        if (m && view.me.actions[m]) {
          e.preventDefault();
          move(m);
        }
      } else if ((k === 'enter' || k === ' ') && view.phase === 'betting' && !betPanel.hidden && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault();
        ready();
      }
    }
    document.addEventListener('keydown', onKey);
    const off = onProfile(() => alive && paintControls());
    onRoom(onSnap);

    return () => {
      alive = false;
      off();
      clearInterval(tid);
      document.removeEventListener('keydown', onKey);
      releaseBalance();
    };
  },
};
