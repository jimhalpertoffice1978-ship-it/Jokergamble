// Battleship table UI (1 v 1, everyone else spectates). The server holds both fleets and the clock;
// this file lets you place your ships, fire shots and watch.
import { app, h, fmt, signed, sfx, celebrate, toast, onProfile, secsLeft } from '../js/core.js';

const SIZE = 10;
const range = (n) => Array.from({ length: n }, (_, i) => i);

export default {
  async mount(root, { act, onRoom, meta }) {
    let alive = true;
    let view = null;
    let prev = null;
    let placed = []; // placement being built: index in fleet -> {x,y,dir} | null
    let fleet = [];
    let sel = 0;
    let dir = 'h';
    let hover = -1;
    let edited = false;
    let tab = 'mine'; // phone: which board is showing
    let lastRound = -1;

    /* ---- elements ---- */
    const mkBoard = (onCell) => {
      const el = h('div', { class: 'bs-grid' });
      range(SIZE * SIZE).forEach((c) =>
        el.append(h('button', { type: 'button', class: 'bs-c', dataset: { c }, 'aria-label': `${String.fromCharCode(65 + (c % SIZE))}${Math.floor(c / SIZE) + 1}`, onclick: () => onCell(c), onmouseenter: () => { hover = c; paintPlacementPreview(); }, onmouseleave: () => { hover = -1; paintPlacementPreview(); } })),
      );
      return el;
    };
    const gridA = mkBoard((c) => cellClick(0, c));
    const gridB = mkBoard((c) => cellClick(1, c));
    const titleA = h('div', { class: 'bs-title' });
    const titleB = h('div', { class: 'bs-title' });
    const boardA = h('section', { class: 'bs-board' }, titleA, gridA);
    const boardB = h('section', { class: 'bs-board' }, titleB, gridB);
    const boards = h('div', { class: 'bs-boards', dataset: { tab } }, boardA, boardB);
    const tabs = h(
      'div',
      { class: 'bs-tabs' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setTab('mine') }, 'My waters'),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setTab('enemy') }, 'Enemy waters'),
    );
    const status = h('div', { class: 'bs-status', role: 'status' });
    const timerEl = h('div', { class: 'bs-timer', role: 'timer' });
    const shipsEl = h('div', { class: 'bs-ships' });
    const controls = h('div', { class: 'bs-controls' });
    const side = h('div', { class: 'bs-side' });
    root.append(h('div', { class: 'bs' }, h('div', { class: 'bs-head' }, status, timerEl), tabs, boards, shipsEl, controls, side));

    const btn = (label, fn, cls = 'btn-ghost btn-sm') => h('button', { class: `btn ${cls}`, type: 'button', onclick: fn }, label);
    const setTab = (t) => {
      tab = t;
      boards.dataset.tab = t;
      paintTabs();
    };
    const paintTabs = () => [...tabs.children].forEach((b, i) => b.classList.toggle('on', (i === 0) === (tab === 'mine')));

    /* ---- helpers ---- */
    const me = () => view.me;
    const seated = () => me().seat != null;
    const myBoard = () => view.boards[me().seat];
    const foeBoard = () => view.boards[1 - me().seat];
    const cellsOf = (x, y, d, len) => range(len).map((k) => (y + (d === 'v' ? k : 0)) * SIZE + x + (d === 'h' ? k : 0));
    const fits = (x, y, d, len, ignore = -1) => {
      if (x < 0 || y < 0 || (d === 'h' ? x + len > SIZE : y + len > SIZE)) return false;
      const used = new Set(placed.flatMap((p, i) => (p && i !== ignore ? cellsOf(p.x, p.y, p.dir, fleet[i].len) : [])));
      return cellsOf(x, y, d, len).every((c) => !used.has(c));
    };
    const adopt = (ships) => {
      // turn the server's fleet back into x/y/dir placements
      placed = fleet.map((_, i) => {
        const cells = ships[i]?.cells;
        if (!cells) return null;
        return { x: cells[0] % SIZE, y: Math.floor(cells[0] / SIZE), dir: cells.length > 1 && cells[1] - cells[0] === 1 ? 'h' : 'v' };
      });
    };
    const nextFree = () => {
      const i = placed.findIndex((p) => !p);
      return i < 0 ? 0 : i;
    };
    const placing = () => view.phase === 'placing' && seated() && !myBoard().ready;

    function cellClick(which, c) {
      if (!view) return;
      if (which === 0 && placing()) return place(c);
      if (which === 1 && view.phase === 'battle' && seated() && view.turn === app.profile.id) return fire(c);
    }
    function place(c) {
      const x = c % SIZE;
      const y = Math.floor(c / SIZE);
      const hit = placed.findIndex((p, i) => p && cellsOf(p.x, p.y, p.dir, fleet[i].len).includes(c));
      if (hit >= 0) {
        placed[hit] = null; // pick a placed ship back up
        sel = hit;
        edited = true;
        sfx.click();
        return paint();
      }
      if (placed[sel]) sel = nextFree();
      if (!fits(x, y, dir, fleet[sel].len)) return toast('That ship does not fit there.', 'bad');
      placed[sel] = { x, y, dir };
      edited = true;
      sfx.chip();
      sel = nextFree();
      paint();
    }
    async function fire(c) {
      const r = await act({ type: 'fire', cell: c });
      if (!r.ok) toast(r.error || 'Could not fire.', 'bad');
      else sfx.tick();
    }
    async function lockIn() {
      if (placed.some((p) => !p)) return toast('Place all five ships first.', 'bad');
      const ships = placed.map((p, i) => ({ ...p, len: fleet[i].len }));
      let r = await act({ type: 'place', ships });
      if (r.ok) r = await act({ type: 'ready' });
      if (!r.ok) toast(r.error || 'Could not lock in.', 'bad');
      else sfx.coin();
    }
    async function randomize() {
      edited = false;
      const r = await act({ type: 'random' });
      if (!r.ok) toast(r.error || 'Could not place.', 'bad');
      else sfx.chip();
    }
    const call = async (a, ok) => {
      const r = await act(a);
      if (!r.ok) toast(r.error || 'Not now.', 'bad');
      else if (ok) sfx.click();
    };

    /* ---- painting ---- */
    function classes(el, map) {
      [...el.children].forEach((b, c) => (b.className = `bs-c ${map[c] || ''}`));
    }
    function paintPlacementPreview() {
      if (!view || !placing()) return;
      paintBoard(0, true);
    }

    function paintBoard(which, withPreview = false) {
      const grid = which === 0 ? gridA : gridB;
      const map = {};
      const mineSeat = seated() ? me().seat : null;
      // which seat's waters this grid shows: players see their own on the left and the enemy on the right
      const seat = mineSeat == null ? which : which === 0 ? mineSeat : 1 - mineSeat;
      const b = view.boards[seat];
      const own = mineSeat === seat;
      if (b) {
        const ships = own ? (placing() ? placed.flatMap((p, i) => (p ? cellsOf(p.x, p.y, p.dir, fleet[i].len) : [])) : b.ships?.flatMap((s) => s.cells) || []) : view.phase === 'result' ? b.ships?.flatMap((s) => s.cells) || [] : [];
        ships.forEach((c) => (map[c] = 'ship'));
        b.sunk.forEach((s) => s.cells.forEach((c) => (map[c] = 'sunk')));
        b.shots.forEach(({ c, hit }) => (map[c] = `${map[c] || ''} ${hit ? 'hit' : 'miss'}`));
        if (view.last && b.id !== view.last.by && b.shots.some((s) => s.c === view.last.cell) && view.last.cell != null) map[view.last.cell] += ' last';
      }
      if (own && placing()) {
        placed.forEach((p, i) => p && cellsOf(p.x, p.y, p.dir, fleet[i].len).forEach((c) => (map[c] = 'ship')));
        if (withPreview && hover >= 0 && !placed[sel]) {
          const x = hover % SIZE;
          const y = Math.floor(hover / SIZE);
          const ok = fits(x, y, dir, fleet[sel].len);
          const cells = cellsOf(x, y, dir, fleet[sel].len).filter((c) => (dir === 'h' ? Math.floor(c / SIZE) === y : c % SIZE === x));
          cells.forEach((c) => (map[c] = `${map[c] || ''} ${ok ? 'pv' : 'pvbad'}`));
        }
      }
      const myTurn = view.phase === 'battle' && seated() && view.turn === app.profile.id;
      const shootable = myTurn && !own;
      [...grid.children].forEach((el, c) => {
        el.className = `bs-c ${map[c] || ''}`;
        el.disabled = !((own && placing()) || (shootable && !map[c]?.includes('hit') && !map[c]?.includes('miss')));
      });
      grid.classList.toggle('aim', shootable);
    }

    function title(which) {
      const mineSeat = seated() ? me().seat : null;
      const seat = mineSeat == null ? which : which === 0 ? mineSeat : 1 - mineSeat;
      const b = view.boards[seat];
      const own = mineSeat === seat;
      const el = which === 0 ? titleA : titleB;
      if (!b) {
        el.replaceChildren(h('b', null, 'Empty seat'), h('span', null, 'Waiting for a captain'));
        return;
      }
      const sunk = b.sunk.length;
      el.replaceChildren(
        h('b', null, own ? 'Your waters' : mineSeat == null ? b.name : `${b.name}'s waters`),
        h('span', null, view.phase === 'placing' ? (b.ready ? 'Fleet ready' : 'Placing...') : view.phase === 'battle' || view.phase === 'result' ? `${sunk}/5 ships sunk` : ''),
      );
      el.classList.toggle('turn', view.phase === 'battle' && view.turn === b.id);
    }

    function paint() {
      if (!view) return;
      paintBoard(0, true);
      paintBoard(1);
      title(0);
      title(1);
      const ph = view.phase;
      const isMine = seated();
      const battleMine = ph === 'battle' && isMine;
      tabs.hidden = ph === 'waiting' && !isMine;
      tabs.children[0].textContent = isMine ? 'My waters' : view.boards[0]?.name || 'Seat 1';
      tabs.children[1].textContent = isMine ? 'Enemy waters' : view.boards[1]?.name || 'Seat 2';
      paintTabs();

      // ship list while placing
      shipsEl.hidden = !placing();
      if (placing()) {
        shipsEl.replaceChildren(
          ...fleet.map((f, i) =>
            h('button', { type: 'button', class: `bs-ship ${placed[i] ? 'done' : ''} ${sel === i && !placed[i] ? 'sel' : ''}`, onclick: () => { if (placed[i]) { placed[i] = null; edited = true; } sel = i; sfx.click(); paint(); } }, h('b', null, f.name), h('span', null, range(f.len).map(() => h('i')))),
          ),
        );
      }

      // controls
      const c = [];
      const stake = view.limits.stake;
      if (!isMine) {
        if (me().queued) c.push(h('div', { class: 'bs-note' }, `You are in the queue (${view.queue.indexOf(app.profile.name) + 1 || '?'} of ${view.queue.length}).`), btn('Leave queue', () => call({ type: 'leave' }, true)));
        else if (ph === 'waiting') c.push(btn(`Take a seat (${stake} tokens)`, () => call({ type: 'sit' }), 'btn-green btn-lg'));
        else c.push(btn(`Join the queue (${stake} tokens when seated)`, () => call({ type: 'sit' }), 'btn-lg'));
        if (!me().canSit) c.push(h('div', { class: 'bs-note' }, `You need ${stake} tokens to play.`));
      } else if (ph === 'waiting') c.push(h('div', { class: 'bs-note' }, 'Seat taken. Waiting for an opponent...'), btn('Stand up (refund)', () => call({ type: 'leave' }, true)));
      else if (placing()) {
        c.push(btn(`Rotate (${dir === 'h' ? 'horizontal' : 'vertical'})`, () => { dir = dir === 'h' ? 'v' : 'h'; sfx.click(); paint(); }), btn('Random', randomize), btn('Clear', () => { placed = fleet.map(() => null); sel = 0; edited = true; paint(); }), btn('Lock in fleet', lockIn, placed.every(Boolean) ? 'btn-green btn-lg' : 'btn-lg'));
        if (placed.some((p) => !p)) c[c.length - 1].disabled = true;
      } else if (ph === 'placing') c.push(h('div', { class: 'bs-note' }, 'Fleet locked. Waiting for your opponent...'));
      else if (battleMine) c.push(btn('Resign (opponent takes the pot)', async () => { if (confirm('Resign and give up the pot?')) call({ type: 'resign' }); }, 'btn-ghost btn-sm'));
      controls.replaceChildren(...c);

      // side info
      const info = [];
      if (view.queue.length) info.push(h('div', { class: 'bs-q' }, h('b', null, 'Next up'), view.queue.slice(0, 5).join(', ')));
      if (view.history.length) info.push(h('div', { class: 'bs-q' }, h('b', null, 'Recent matches'), ...view.history.slice(0, 3).map((m) => h('div', null, `${m.winner} beat ${m.loser}`))));
      side.replaceChildren(...info);
      statusPaint();
    }

    function statusPaint() {
      if (!view) return;
      const ph = view.phase;
      const isMine = seated();
      const myId = app.profile.id;
      const nameOf = (id) => view.boards.find((b) => b?.id === id)?.name || 'Opponent';
      let main = '';
      let sub = '';
      if (ph === 'waiting') main = 'Waiting for players';
      else if (ph === 'placing') main = isMine ? (myBoardReady() ? 'Fleet locked in' : 'Place your fleet') : 'Captains are placing their fleets';
      else if (ph === 'battle') {
        main = view.turn === myId ? 'Your turn: fire!' : isMine ? `${nameOf(view.turn)} is aiming...` : `${nameOf(view.turn)} to fire`;
        if (view.last) {
          const who = view.last.by === myId ? 'You' : nameOf(view.last.by);
          sub = view.last.sunk ? `${who} sank the ${view.last.sunk.name}!` : view.last.hit ? `${who} scored a hit` : `${who} missed`;
        }
      } else if (ph === 'result') {
        main = view.winner === myId ? `Victory! +${fmt(view.pot)}` : isMine ? 'Defeat' : `${nameOf(view.winner)} wins ${fmt(view.pot)}`;
        sub = 'Next match starts shortly';
      }
      status.className = `bs-status ${ph === 'result' && view.winner === myId ? 'win' : ''} ${ph === 'battle' && view.turn === myId ? 'go' : ''}`;
      status.replaceChildren(...[h('b', null, main), sub ? h('span', null, sub) : null].filter(Boolean));
    }
    const myBoardReady = () => !!myBoard()?.ready;

    function timerPaint() {
      if (!view) return;
      const s = secsLeft(view.deadline);
      let t = '';
      if (view.phase === 'placing') t = `Fleet locks in ${s}s`;
      else if (view.phase === 'battle') t = view.turn === app.profile.id ? `Fire within ${s}s` : `${s}s`;
      else if (view.phase === 'waiting' && view.deadline && seated()) t = `Seat held for ${s}s`;
      timerEl.textContent = t;
      timerEl.classList.toggle('urgent', s != null && s <= 5 && ['placing', 'battle'].includes(view.phase));
    }
    const tid = setInterval(timerPaint, 250);

    function onSnap(snap) {
      if (!alive) return;
      prev = view;
      view = snap.view;
      fleet = view.limits.fleet;
      if (!placed.length) placed = fleet.map(() => null);
      if (view.round !== lastRound || (prev && prev.phase !== 'placing' && view.phase === 'placing')) {
        lastRound = view.round;
        placed = fleet.map(() => null);
        sel = 0;
        edited = false;
        tab = 'mine';
        boards.dataset.tab = tab;
      }
      if (seated() && view.phase === 'placing') {
        const mine = myBoard();
        if (mine?.ships && (!edited || mine.ready)) adopt(mine.ships);
      }
      // auto switch the phone tab to whoever acts
      if (seated() && view.phase === 'battle') {
        const myTurn = view.turn === app.profile.id;
        if (!prev || prev.phase !== 'battle' || prev.turn !== view.turn) setTab(myTurn ? 'enemy' : 'mine');
      }
      // sound + celebration for the shot that just landed
      if (prev && view.last && (!prev.last || prev.last.cell !== view.last.cell || prev.last.by !== view.last.by) && view.phase !== 'placing') {
        if (view.last.sunk) sfx.big();
        else if (view.last.hit) sfx.win();
        else sfx.flip();
      }
      if (prev && prev.phase !== 'result' && view.phase === 'result' && seated()) {
        if (view.winner === app.profile.id) celebrate(view.pot - view.limits.stake, view.limits.stake, status);
        else sfx.lose();
      }
      paint();
      timerPaint();
    }

    const off = onProfile(() => alive && view && paint());
    onRoom(onSnap);

    return () => {
      alive = false;
      off();
      clearInterval(tid);
    };
  },
};
