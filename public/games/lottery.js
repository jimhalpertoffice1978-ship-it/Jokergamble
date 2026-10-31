// Shared Lucky Draw lottery. The server sells tickets, runs the clock, draws the balls and pays everybody;
// this file lets you pick numbers and shows the draw.
import { app, h, fmt, signed, sleep, sfx, releaseBalance, celebrate, floatText, toast, rebuy, onProfile, secsLeft, reduceMotion } from '../js/core.js';

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const sortN = (a) => [...a].sort((x, y) => x - y);
const same = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);

export default {
  async mount(root, { act, onRoom }) {
    let alive = true;
    let view = null;
    let prev = null;
    let tickets = []; // my confirmed + pending tickets (arrays of 5)
    let picks = []; // numbers selected for the ticket being built
    let dirty = false;
    let pushing = false;
    let revealed = 0; // balls shown so far
    let spinP = Promise.resolve();
    let clockNow = () => Date.now();

    /* ---- layout ---- */
    const jackpot = h('div', { class: 'lt-jackpot-amt' }, '0');
    const timerEl = h('div', { class: 'lt-timer', role: 'timer' });
    const balls = h('div', { class: 'lt-balls', 'aria-label': 'Drawn numbers' }, range(5).map(() => h('span', { class: 'lt-ball empty' }, '?')));
    const status = h('div', { class: 'lt-status', role: 'status' });
    const prizeRow = h('div', { class: 'lt-prizes' });
    const hist = h('div', { class: 'lt-hist' });
    const crowd = h('div', { class: 'lt-crowd' });
    const machine = h('div', { class: 'felt lt-machine' }, h('div', { class: 'lt-jackpot' }, h('span', null, 'Jackpot'), jackpot), balls, status, timerEl, prizeRow);

    const board = h('div', { class: 'lt-board' }, range(36).map((n) => h('button', { type: 'button', class: 'lt-num', dataset: { n }, 'aria-label': `Number ${n}`, onclick: () => toggle(n) }, String(n))));
    const slip = h('div', { class: 'lt-slip' });
    const bQuick = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { quick(1); } }, 'Quick pick');
    const bQuick5 = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => quick(5) }, 'Quick pick x5');
    const bClearPick = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { picks = []; sfx.click(); paint(); } }, 'Clear numbers');
    const bAdd = h('button', { class: 'btn btn-green', type: 'button', onclick: addTicket }, 'Add ticket');
    const bRepeat = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: repeat }, 'Repeat last draw');
    const bClearAll = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: clearAll }, 'Remove all');
    const total = h('div', { class: 'lt-total' });
    const broke = h('div', { class: 'bj-broke' }, h('h3', null, 'Out of tokens!'), h('p', null, 'The house will front you a fresh stack.'), h('button', { class: 'btn btn-red btn-lg', type: 'button', onclick: () => rebuy() }, `Fresh start +${app.meta.rebuy}`));
    const picker = h('div', { class: 'lt-picker' }, h('div', { class: 'lt-hint' }, 'Pick 5 numbers'), board, h('div', { class: 'lt-actions' }, bAdd, bQuick, bQuick5, bClearPick), broke);
    const mine = h('div', { class: 'lt-mine' }, h('div', { class: 'lt-hint' }, 'Your tickets'), slip, total, h('div', { class: 'lt-actions' }, bRepeat, bClearAll));

    root.append(h('div', { class: 'lt' }, h('div', { class: 'lt-left' }, machine, hist, crowd), h('div', { class: 'lt-right' }, picker, mine)));

    /* ---- editing ---- */
    const open = () => view?.phase === 'selling';
    const L = () => view.limits;
    const confirmed = () => view.me.tickets.length;
    const budget = () => app.profile.balance + confirmed() * L().price; // staked tokens are already debited server side

    function toggle(n) {
      if (!open()) return;
      if (picks.includes(n)) picks = picks.filter((x) => x !== n);
      else if (picks.length < L().picks) picks = [...picks, n];
      else return toast(`A ticket has ${L().picks} numbers. Add it or clear to start over.`);
      sfx.chip();
      paint();
    }
    function canAdd(extra = 1) {
      return tickets.length + extra <= L().maxTickets && (tickets.length + extra) * L().price <= budget();
    }
    function addTicket() {
      if (!open() || picks.length !== L().picks) return;
      if (!canAdd()) return toast(tickets.length >= L().maxTickets ? `Maximum ${L().maxTickets} tickets per draw.` : 'Not enough tokens for another ticket.', 'bad');
      tickets = [...tickets, sortN(picks)];
      picks = [];
      sfx.coin();
      edited();
    }
    function randomTicket() {
      const pool = range(L().pool);
      const t = [];
      while (t.length < L().picks) t.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      return sortN(t);
    }
    function quick(n) {
      if (!open()) return;
      let added = 0;
      for (let i = 0; i < n && canAdd(); i++) {
        tickets = [...tickets, randomTicket()];
        added++;
      }
      if (!added) return toast(tickets.length >= L().maxTickets ? `Maximum ${L().maxTickets} tickets per draw.` : 'Not enough tokens for another ticket.', 'bad');
      picks = [];
      sfx.coin();
      edited();
    }
    function removeAt(i) {
      if (!open()) return;
      tickets = tickets.filter((_, k) => k !== i);
      sfx.click();
      edited();
    }
    function clearAll() {
      if (!open() || !tickets.length) return;
      tickets = [];
      sfx.click();
      edited();
    }
    function repeat() {
      if (!open() || !view.me.lastTickets.length) return;
      tickets = view.me.lastTickets.slice(0, Math.min(L().maxTickets, Math.floor(budget() / L().price)));
      sfx.coin();
      edited();
    }
    function edited() {
      dirty = true;
      paint();
      clearTimeout(edited.t);
      edited.t = setTimeout(sync, 160);
    }
    async function sync() {
      if (pushing || !alive || !open()) return;
      pushing = true;
      while (dirty && alive && open()) {
        dirty = false;
        const r = await act({ type: 'setTickets', tickets });
        if (!r.ok) {
          toast(r.error || 'The ticket desk could not take those.', 'bad');
          tickets = view.me.tickets;
          dirty = false;
          paint();
        }
      }
      pushing = false;
    }

    /* ---- drawing ---- */
    const hitSet = () => new Set((view?.drawn || []).slice(0, revealed));

    function paint() {
      if (!view) return;
      const betting = open();
      const hit = hitSet();
      const result = view.me.result;
      jackpot.textContent = fmt(view.jackpot);
      board.querySelectorAll('.lt-num').forEach((b) => {
        const n = +b.dataset.n;
        b.classList.toggle('sel', picks.includes(n));
        b.classList.toggle('drawn', hit.has(n));
        b.disabled = !betting;
      });
      slip.replaceChildren(
        ...(tickets.length
          ? tickets.map((t, i) => {
              const row = result?.tickets[i];
              const hits = t.filter((n) => hit.has(n)).length;
              const done = !betting && revealed >= (view.drawn?.length ?? 99);
              return h(
                'div',
                { class: `lt-ticket ${done && row && row.prize ? 'won' : ''}` },
                h('span', { class: 'lt-tn' }, i + 1),
                h('span', { class: 'lt-nums' }, t.map((n) => h('i', { class: hit.has(n) ? 'hit' : '' }, String(n)))),
                betting ? h('button', { class: 'lt-x', type: 'button', 'aria-label': `Remove ticket ${i + 1}`, onclick: () => removeAt(i) }, '×') : h('span', { class: 'lt-prize' }, done && row ? (row.prize ? `+${fmt(row.prize)}` : `${row.hits}/5`) : `${hits}/5`),
              );
            })
          : [h('div', { class: 'lt-empty' }, betting ? 'No tickets yet. Pick numbers or quick pick.' : 'You are not in this draw.')]),
      );
      const cost = tickets.length * L().price;
      total.textContent = tickets.length ? `${tickets.length} ticket${tickets.length > 1 ? 's' : ''} · ${fmt(cost)} tokens` : '';
      bAdd.disabled = !betting || picks.length !== L().picks;
      bAdd.textContent = picks.length === L().picks ? 'Add ticket' : `${picks.length}/${L().picks} picked`;
      bQuick.disabled = bQuick5.disabled = !betting;
      bClearPick.disabled = !betting || !picks.length;
      bRepeat.disabled = !betting || !view.me.lastTickets.length;
      bClearAll.disabled = !betting || !tickets.length;
      picker.classList.toggle('closed', !betting);
      broke.hidden = !(betting && app.profile.canRebuy && !tickets.length);
      prizeRow.replaceChildren(...Object.entries(view.prizes).map(([k, v]) => h('div', { class: 'lt-pz' }, h('b', null, `${k} match`), h('span', null, typeof v === 'number' ? fmt(v) : v))));
      hist.replaceChildren(h('b', null, 'Recent draws'), ...view.history.slice(0, 5).map((d) => h('div', { class: `lt-h ${d.jackpotWon ? 'jp' : ''}` }, h('em', null, `#${d.round}`), d.drawn.map((n) => h('i', null, String(n))), d.jackpotWon ? h('strong', null, `JACKPOT ${fmt(d.jackpotWon)}`) : null)));
      const others = view.players.filter((p) => p.id !== app.profile.id);
      crowd.replaceChildren(...(others.length ? [h('b', null, 'In this draw'), ...others.map((p) => h('div', { class: 'lt-pl' }, h('span', null, p.name), h('span', { class: p.net > 0 ? 'up' : p.net < 0 ? 'down' : '' }, view.phase === 'result' && p.net != null ? signed(p.net) : `${p.count} ticket${p.count > 1 ? 's' : ''}`)))] : []));
    }

    function paintBalls() {
      // update in place so a ball that is already showing never restarts its animation
      const d = view.drawn;
      [...balls.children].forEach((el, i) => {
        const want = d && i < revealed ? String(d[i]) : null;
        if (want) {
          if (el.textContent !== want || !el.classList.contains('pop')) {
            el.textContent = want;
            el.className = 'lt-ball pop';
          }
        } else if (!el.classList.contains('rolling')) {
          el.textContent = '?';
          el.className = 'lt-ball empty';
        }
      });
    }

    function timerPaint() {
      if (!view) return;
      const s = secsLeft(view.deadline);
      let text = '';
      if (view.phase === 'selling') text = view.deadline ? `Draw in ${s}s` : 'The draw starts after the first ticket';
      else if (view.phase === 'drawing') text = 'Drawing...';
      timerEl.textContent = text;
      timerEl.classList.toggle('urgent', view.phase === 'selling' && view.deadline && s <= 5);
    }
    const tid = setInterval(timerPaint, 250);

    async function reveal(ms) {
      revealed = 0;
      status.className = 'lt-status';
      status.textContent = 'Balls rolling...';
      paintBalls();
      // each ball tumbles through random numbers, then locks onto the drawn one; the last ball gets the most suspense
      const slot = reduceMotion() ? 200 : Math.max(450, (ms * 0.9) / 5);
      for (let i = 0; i < 5 && alive; i++) {
        const el = balls.children[i];
        const spin = setInterval(() => {
          el.className = 'lt-ball rolling';
          el.textContent = String(1 + Math.floor(Math.random() * 36));
        }, 70);
        await sleep(slot * (i === 4 ? 1.15 : 1));
        clearInterval(spin);
        el.classList.remove('rolling');
        revealed = i + 1;
        sfx.tick();
        paintBalls();
        paint();
      }
    }

    async function onSnap(snap) {
      if (!alive) return;
      const arrived = Date.now();
      clockNow = () => snap.serverNow + (Date.now() - arrived);
      const nv = snap.view;
      prev = view;
      view = nv;
      const phaseChanged = !prev || prev.phase !== nv.phase || prev.round !== nv.round;

      if (nv.phase === 'selling') {
        if (!prev || prev.phase !== 'selling' || prev.round !== nv.round) {
          tickets = nv.me.tickets;
          picks = [];
          dirty = false;
          revealed = 0;
          status.className = 'lt-status';
          status.textContent = 'Pick your numbers';
          paintBalls();
        } else if (!dirty && !pushing) tickets = nv.me.tickets;
        paint();
        timerPaint();
        return;
      }

      tickets = nv.me.tickets;
      if (nv.phase === 'drawing') {
        if (phaseChanged && tickets.length) app.hold = true;
        paint();
        timerPaint();
        if (phaseChanged) {
          const ms = nv.deadline - clockNow();
          if (!prev || ms < 800) {
            revealed = 5;
            paintBalls();
            paint();
          } else spinP = reveal(ms);
        }
        return;
      }

      // result
      timerPaint();
      await spinP;
      if (!alive || view !== nv) return;
      revealed = 5;
      paintBalls();
      paint();
      const r = nv.me.result;
      const top = nv.history[0];
      if (top?.jackpotWon) status.className = 'lt-status win';
      status.replaceChildren(
        h('b', null, top?.jackpotWon ? 'JACKPOT!' : 'Draw complete'),
        h('span', null, r ? (r.net > 0 ? `You won ${fmt(r.returned)} (${signed(r.net)})` : r.net < 0 ? `${signed(r.net)} tokens. Next draw soon.` : 'You got your stake back.') : 'Tickets for the next draw open soon.'),
      );
      if (phaseChanged && prev?.phase === 'drawing' && r) {
        if (r.net > 0) celebrate(r.net, r.wagered, balls);
        else if (r.net < 0) sfx.lose();
        if (r.net !== 0) floatText(balls, signed(r.net), r.net < 0 ? 'neg' : '');
      }
      releaseBalance();
    }

    const off = onProfile(() => alive && view && paint());
    onRoom(onSnap);

    return () => {
      alive = false;
      off();
      clearInterval(tid);
      clearTimeout(edited.t);
      releaseBalance();
    };
  },
};
