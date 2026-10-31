// Blackjack Duel table UI (1 v 1, no dealer). Server deals and decides; this file draws and sends hit / stand.
import { app, h, fmt, signed, sfx, celebrate, toast, onProfile, secsLeft } from '../js/core.js';

const GLYPH = { S: '♠︎', H: '♥︎', D: '♦︎', C: '♣︎' };
const isRed = (s) => s === 'H' || s === 'D';

function cardEl(c, delay = null) {
  const el = c
    ? h('div', { class: `pc ${isRed(c.suit) ? 'red' : ''}`, 'aria-label': `${c.rank} of ${c.suit}` }, h('span', { class: 'r tl' }, c.rank, h('i', null, GLYPH[c.suit])), h('span', { class: 'pip' }, GLYPH[c.suit]), h('span', { class: 'r br' }, c.rank, h('i', null, GLYPH[c.suit])))
    : h('div', { class: 'pc back', 'aria-label': 'Hidden card' });
  if (delay != null) {
    el.classList.add('enter');
    el.style.setProperty('--d', `${delay}s`);
  }
  return el;
}

export default {
  async mount(root, { act, onRoom }) {
    let alive = true;
    let view = null;
    let prev = null;
    let lastRound = -1;

    const topHand = h('div', { class: 'dl-hand' });
    const botHand = h('div', { class: 'dl-hand' });
    const mid = h('div', { class: 'dl-mid' });
    const status = h('div', { class: 'dl-status', role: 'status' });
    const timerEl = h('div', { class: 'dl-timer', role: 'timer' });
    mid.append(status, timerEl);
    const felt = h('div', { class: 'felt dl-felt' }, topHand, mid, botHand);
    const bHit = h('button', { class: 'btn btn-lg btn-green', type: 'button', onclick: () => move('hit') }, 'Hit', h('small', null, 'H'));
    const bStand = h('button', { class: 'btn btn-lg btn-red', type: 'button', onclick: () => move('stand') }, 'Stand', h('small', null, 'S'));
    const actions = h('div', { class: 'bj-actions dl-actions' }, bHit, bStand);
    const controls = h('div', { class: 'dl-controls' });
    const side = h('div', { class: 'dl-side' });
    root.append(h('div', { class: 'dl' }, felt, actions, controls, side));

    const btn = (label, fn, cls = 'btn-ghost btn-sm') => h('button', { class: `btn ${cls}`, type: 'button', onclick: fn }, label);
    const seated = () => view.me.seat != null;
    const mineIdx = () => (seated() ? view.me.seat : 0);
    const call = async (a, snd) => {
      const r = await act(a);
      if (!r.ok) toast(r.error || 'Not now.', 'bad');
      else if (snd) sfx.click();
    };
    async function move(type) {
      if (!view || view.phase !== 'playing' || view.turn !== app.profile.id) return;
      bHit.disabled = bStand.disabled = true;
      const r = await act({ type });
      if (!r.ok) toast(r.error || 'That move did not work.', 'bad');
    }

    function handEl(hd, own, animate, isTurn) {
      if (!hd) return h('div', { class: 'dl-seat empty' }, h('div', { class: 'dl-name' }, 'Empty seat'), h('div', { class: 'dl-cards' }, h('div', { class: 'pc ghost' }), h('div', { class: 'pc ghost' })));
      const before = animate?.byId?.[hd.id] ?? 0;
      const fresh = animate?.all;
      const cards = hd.cards.map((c, i) => (fresh ? cardEl(c, i * 0.3 + (own ? 0 : 0.15)) : i >= before && animate ? cardEl(c, (i - before) * 0.3) : cardEl(c)));
      const bust = hd.status === 'bust';
      const info = own || view.phase === 'result' ? `${hd.soft && hd.total < 21 ? 'Soft ' : ''}${hd.total}${hd.natural ? ' · Blackjack' : ''}` : hd.showing != null ? `Showing ${hd.showing}` : '';
      const chip = bust ? 'Bust' : hd.status === 'stand' && view.phase === 'playing' ? 'Stands' : '';
      return h(
        'div',
        { class: `dl-seat ${isTurn ? 'turn' : ''} ${bust ? 'bust' : ''} ${view.phase === 'result' && view.outcome?.winner === hd.id ? 'winner' : ''}` },
        h('div', { class: 'dl-name' }, own ? 'You' : hd.name, chip ? h('em', null, chip) : null),
        h('div', { class: 'dl-cards' }, cards),
        h('div', { class: `bj-total ${bust ? 'bust' : ''}` }, bust ? `Bust (${hd.total ?? '?'})` : info || '?'),
      );
    }

    function paint(animate) {
      const me = mineIdx();
      const own = seated();
      const hMe = view.hands[me];
      const hFoe = view.hands[1 - me];
      botHand.replaceChildren(handEl(hMe, own, animate, view.phase === 'playing' && hMe && view.turn === hMe.id));
      topHand.replaceChildren(handEl(hFoe, false, animate, view.phase === 'playing' && hFoe && view.turn === hFoe.id));
      // status
      const ph = view.phase;
      const myId = app.profile.id;
      const nm = (id) => view.hands.find((x) => x?.id === id)?.name || 'Rival';
      let main = '';
      let sub = '';
      if (ph === 'waiting') main = 'Waiting for a rival';
      else if (ph === 'playing') {
        main = view.turn === myId ? 'Your move' : own ? `${nm(view.turn)} is deciding...` : `${nm(view.turn)} to act`;
        sub = view.turn === myId ? 'Hit or stand. Closest to 21 wins.' : '';
      } else {
        const w = view.outcome?.winner;
        main = !w ? 'Push' : w === myId ? `You win +${fmt(view.pot - view.limits.stake)}` : own ? 'You lose' : `${nm(w)} wins`;
        sub = view.outcome?.reason || '';
      }
      status.className = `dl-status ${ph === 'result' && view.outcome?.winner === myId ? 'win' : ''} ${ph === 'playing' && view.turn === myId ? 'go' : ''}`;
      status.replaceChildren(...[h('b', null, main), sub ? h('span', null, sub) : null].filter(Boolean));

      const myTurn = ph === 'playing' && view.turn === myId;
      actions.hidden = !(own && ph === 'playing');
      bHit.disabled = bStand.disabled = !myTurn;

      const c = [];
      const stake = view.limits.stake;
      if (!own) {
        if (view.me.queued) c.push(h('div', { class: 'bs-note' }, `You are in the queue (${view.queue.indexOf(app.profile.name) + 1 || '?'} of ${view.queue.length}).`), btn('Leave queue', () => call({ type: 'leave' }, true)));
        else if (ph === 'waiting') c.push(btn(`Take a seat (${stake} tokens)`, () => call({ type: 'sit' }), 'btn-green btn-lg'));
        else c.push(btn(`Join the queue (${stake} tokens when seated)`, () => call({ type: 'sit' }), 'btn-lg'));
        if (!view.me.canSit) c.push(h('div', { class: 'bs-note' }, `You need ${stake} tokens to play.`));
      } else if (ph === 'waiting') c.push(h('div', { class: 'bs-note' }, 'Seat taken. Waiting for a rival...'), btn('Stand up (refund)', () => call({ type: 'leave' }, true)));
      else if (ph === 'playing') c.push(btn('Resign (rival takes the pot)', () => confirm('Resign and give up the pot?') && call({ type: 'resign' })));
      controls.replaceChildren(...c);

      const info = [];
      if (view.queue.length) info.push(h('div', { class: 'bs-q' }, h('b', null, 'Next up'), view.queue.slice(0, 5).join(', ')));
      if (view.history.length) info.push(h('div', { class: 'bs-q' }, h('b', null, 'Recent duels'), ...view.history.slice(0, 3).map((m) => h('div', null, m.winner ? `${m.winner} beat ${m.winner === m.a ? m.b : m.a}` : `${m.a} and ${m.b} pushed`))));
      side.replaceChildren(...info);
    }

    function timerPaint() {
      if (!view) return;
      const s = secsLeft(view.deadline);
      let t = '';
      if (view.phase === 'playing' && view.turn) t = view.turn === app.profile.id ? `Decide within ${s}s` : `${s}s`;
      else if (view.phase === 'waiting' && view.deadline && seated()) t = `Seat held for ${s}s`;
      timerEl.textContent = t;
      timerEl.classList.toggle('urgent', s != null && s <= 5 && view.phase === 'playing' && view.turn === app.profile.id);
    }
    const tid = setInterval(timerPaint, 250);

    function onSnap(snap) {
      if (!alive) return;
      prev = view;
      view = snap.view;
      const newRound = view.round !== lastRound || (prev && prev.phase !== 'playing' && view.phase === 'playing');
      lastRound = view.round;
      let animate = null;
      if (view.phase === 'playing' || view.phase === 'result') {
        if (newRound || !prev) animate = prev ? { all: true } : null;
        else animate = { byId: Object.fromEntries((prev.hands || []).filter(Boolean).map((x) => [x.id, x.cards.length])) };
      }
      if (animate?.all) for (let i = 0; i < 4; i++) setTimeout(() => alive && sfx.card(), i * 300 + 60);
      else if (animate && prev) {
        const grew = view.hands.some((x) => x && animate.byId[x.id] != null && x.cards.length > animate.byId[x.id]);
        if (grew) sfx.card();
      }
      // flip-the-reveal feel at the end
      if (prev && prev.phase !== 'result' && view.phase === 'result') {
        const w = view.outcome?.winner;
        if (seated()) {
          if (w === app.profile.id) celebrate(view.pot - view.limits.stake, view.limits.stake, status);
          else if (w) sfx.lose();
          else sfx.push();
        }
      }
      paint(animate);
      timerPaint();
    }

    function onKey(e) {
      if (e.target.matches?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey || !view) return;
      const k = e.key.toLowerCase();
      if (k === 'h') move('hit');
      else if (k === 's') move('stand');
    }
    document.addEventListener('keydown', onKey);
    const off = onProfile(() => alive && view && paint(null));
    onRoom(onSnap);

    return () => {
      alive = false;
      off();
      clearInterval(tid);
      document.removeEventListener('keydown', onKey);
    };
  },
};
