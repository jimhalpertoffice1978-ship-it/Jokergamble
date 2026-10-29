// Shared Roulette table. ONE wheel for everybody: the server runs the countdown, picks the number and
// pays everyone at once. This file draws the wheel, your chips, the other players and the celebration.
import { app, h, svg, fmt, signed, sleep, sfx, chip, chipTray, releaseBalance, celebrate, floatText, toast, rebuy, onProfile, reduceMotion, secsLeft } from '../js/core.js';
import { WHEEL, coverage, colorOf, betKey } from './roulette-rules.js';

const STEP = 360 / 37;
const FILL = { green: '#0f7a47', red: '#c41e2d', black: '#17082a' };
const OUTSIDE = [
  ['low', '1-18'], ['even', 'EVEN'], ['red', ''], ['black', ''], ['odd', 'ODD'], ['high', '19-36'],
];
const DOZENS = [[1, '1st 12'], [2, '2nd 12'], [3, '3rd 12']];
const LABELS = { straight: 'Straight', split: 'Split', street: 'Street', corner: 'Corner', sixline: 'Six line', column: 'Column', dozen: 'Dozen', red: 'Red', black: 'Black', odd: 'Odd', even: 'Even', low: '1 to 18', high: '19 to 36' };

const pt = (r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [160 + r * Math.cos(a), 160 + r * Math.sin(a)];
};

function wheelMarkup() {
  let pockets = '';
  let nums = '';
  WHEEL.forEach((n, i) => {
    const [x0, y0] = pt(140, (i - 0.5) * STEP);
    const [x1, y1] = pt(140, (i + 0.5) * STEP);
    const [x2, y2] = pt(104, (i + 0.5) * STEP);
    const [x3, y3] = pt(104, (i - 0.5) * STEP);
    pockets += `<path d="M${x0.toFixed(2)} ${y0.toFixed(2)} A140 140 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A104 104 0 0 0 ${x3.toFixed(2)} ${y3.toFixed(2)}Z" fill="${FILL[colorOf(n)]}" stroke="#d9b55a" stroke-width=".9"/>`;
    nums += `<text x="160" y="43" transform="rotate(${(i * STEP).toFixed(3)} 160 160)" text-anchor="middle" font-family="Playfair Display, Georgia, serif" font-weight="700" font-size="11" fill="#fff6dc">${n}</text>`;
  });
  return `<svg viewBox="0 0 320 320" class="rl-wheel" role="img" aria-label="Roulette wheel">
  <defs>
    <radialGradient id="rim" cx=".4" cy=".35" r=".95"><stop offset="0" stop-color="#b8742f"/><stop offset=".7" stop-color="#5a2c0e"/><stop offset="1" stop-color="#2d1405"/></radialGradient>
    <radialGradient id="cone" cx=".4" cy=".35" r=".9"><stop offset="0" stop-color="#6a3aa8"/><stop offset=".65" stop-color="#2a0e4d"/><stop offset="1" stop-color="#14051f"/></radialGradient>
    <radialGradient id="ball" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#c9c3b5"/></radialGradient>
  </defs>
  <circle cx="160" cy="160" r="158" fill="url(#rim)"/>
  <circle cx="160" cy="160" r="152" fill="none" stroke="#f6c744" stroke-width="3"/>
  <circle cx="160" cy="160" r="146" fill="#0c0314"/>
  <g class="wheel-rot">
    <circle cx="160" cy="160" r="142" fill="#0c0314"/>
    ${pockets}
    <path class="pocket-hl" d="" fill="rgba(255,240,170,.6)" stroke="#fff6cf" stroke-width="2"/>
    ${nums}
    <circle cx="160" cy="160" r="104" fill="url(#cone)" stroke="#f6c744" stroke-width="2"/>
    <g stroke="#f6c744" stroke-width="3" stroke-linecap="round" opacity=".9"><path d="M160 74 V246 M74 160 H246"/></g>
    <circle cx="160" cy="160" r="22" fill="#f6c744" stroke="#b87a14" stroke-width="3"/>
    <circle cx="160" cy="160" r="8" fill="#b87a14"/>
    <g class="ball-rot"><circle class="ball" cx="160" cy="14" r="6" fill="url(#ball)" stroke="#8a8372" stroke-width=".6"/></g>
  </g>
  <path d="M160 6 l9 14 h-18z" fill="#ff3d9a" stroke="#fff" stroke-width="1.2"/>
</svg>`;
}

const pocketPath = (i) => {
  const [x0, y0] = pt(140, (i - 0.5) * STEP);
  const [x1, y1] = pt(140, (i + 0.5) * STEP);
  const [x2, y2] = pt(104, (i + 0.5) * STEP);
  const [x3, y3] = pt(104, (i - 0.5) * STEP);
  return `M${x0} ${y0} A140 140 0 0 1 ${x1} ${y1} L${x2} ${y2} A104 104 0 0 0 ${x3} ${y3}Z`;
};

export default {
  async mount(root, { act, onRoom }) {
    let alive = true;
    let view = null;
    let prev = null;
    let skip = false;
    let dirty = false; // local edits not yet confirmed by the server
    let pushing = false;
    let spinP = Promise.resolve();
    let wheelAngle = Math.random() * 360;
    let bets = new Map(); // key -> {type, sel, amount}
    let hist = []; // undo snapshots

    /* ------------------------------------------------ wheel + status */
    const wheel = svg(wheelMarkup());
    const rot = wheel.querySelector('.wheel-rot');
    const ballRot = wheel.querySelector('.ball-rot');
    const ball = wheel.querySelector('.ball');
    const hl = wheel.querySelector('.pocket-hl');
    const hub = h('div', { class: 'rl-hub' });
    const wheelBox = h('button', { class: 'rl-wheelbox', type: 'button', 'aria-label': 'Skip the spin animation', onclick: () => (skip = true) }, wheel, hub);
    const status = h('div', { class: 'rl-status', role: 'status' });
    const histEl = h('div', { class: 'rl-hist', 'aria-label': 'Recent numbers' });
    const hotEl = h('div', { class: 'rl-hot' });
    const setWheel = (w, r, rr) => {
      rot.setAttribute('transform', `rotate(${w} 160 160)`);
      ballRot.setAttribute('transform', `rotate(${r} 160 160)`);
      ball.setAttribute('cy', String(160 - rr));
    };

    /* ------------------------------------------------ betting layout */
    const anchors = new Map(); // key -> element
    const cells = new Map(); // number -> element
    const stacks = new Map(); // key -> chip stack element

    function target(el, type, sel, label) {
      const cov = coverage(type, sel);
      const key = betKey(type, sel);
      el.dataset.key = key;
      el.setAttribute('aria-label', `${label}: ${LABELS[type]}`);
      el.addEventListener('click', () => place(type, sel));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        removeOne(key);
      });
      el.addEventListener('mouseenter', () => cov.forEach((n) => cells.get(n)?.classList.add('hl')));
      el.addEventListener('mouseleave', () => cells.forEach((c) => c.classList.remove('hl')));
      anchors.set(key, el);
      return el;
    }
    const btn = (cls, ...kids) => h('button', { type: 'button', class: cls }, ...kids);

    const zero = target(btn('rc zero', h('span', null, '0')), 'straight', 0, '0');
    cells.set(0, zero);
    const grid = h('div', { class: 'rt-grid' });
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 3; c++) {
        const n = 3 * r + c + 1;
        const el = target(btn(`rc rn ${colorOf(n) === 'red' ? 'red' : 'blk'}`, h('span', null, String(n))), 'straight', n, String(n));
        cells.set(n, el);
        grid.append(el);
      }
    }
    const nums = h('div', { class: 'rt-nums' }, grid);
    const spot = (type, sel, x, y, cls, label) => {
      const el = target(btn(`hs ${cls}`), type, sel, label);
      el.style.setProperty('--x', x);
      el.style.setProperty('--y', y);
      nums.append(el);
    };
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 3; c++) {
        const n = 3 * r + c + 1;
        if (c < 2) spot('split', [n, n + 1], (c + 1) / 3, (r + 0.5) / 12, 'sp-v', `${n}-${n + 1}`);
        if (r < 11) spot('split', [n, n + 3], (c + 0.5) / 3, (r + 1) / 12, 'sp-h', `${n}-${n + 3}`);
      }
    }
    for (let r = 0; r < 12; r++) spot('street', r + 1, 0, (r + 0.5) / 12, 'street', `Row ${r + 1}`);
    for (let r = 0; r < 11; r++) spot('sixline', r + 1, 0, (r + 1) / 12, 'six', `Rows ${r + 1}-${r + 2}`);
    for (let r = 0; r < 11; r++) for (let c = 0; c < 2; c++) spot('corner', 3 * r + c + 1, (c + 1) / 3, (r + 1) / 12, 'corner', `Corner ${3 * r + c + 1}`);
    for (let c = 0; c < 3; c++) spot('split', [0, c + 1], (c + 0.5) / 3, 0, 'sp-h zero-sp', `0-${c + 1}`);

    const even = h(
      'div',
      { class: 'rt-even' },
      OUTSIDE.map(([type, text]) => {
        const el = target(btn(`rc out ${type}`, text ? h('span', { class: 'v' }, text) : h('i', { class: 'dia' })), type, undefined, text || type);
        return el;
      }),
    );
    const doz = h('div', { class: 'rt-doz' }, DOZENS.map(([k, text]) => target(btn('rc out', h('span', { class: 'v' }, text)), 'dozen', k, text)));
    const cols = h('div', { class: 'rt-cols' }, [1, 2, 3].map((k) => target(btn('rc out', h('span', null, '2:1')), 'column', k, `Column ${k}`)));
    const table = h('div', { class: 'rt' }, h('div', { class: 'rt-zero' }, zero), even, doz, nums, cols);
    const felt = h('div', { class: 'felt rl-felt' }, table);

    /* ------------------------------------------------ controls */
    const totalEl = h('div', { class: 'rl-total' });
    const timerEl = h('div', { class: 'rl-timer', role: 'timer' });
    const tray = chipTray({ selectable: true });
    const bClear = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { pushHist(); bets.clear(); sfx.click(); edited(); } }, 'Clear');
    const bUndo = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: undo }, 'Undo');
    const bRepeat = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: repeat }, 'Repeat last');
    const bDouble = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: doubleAll }, 'x2');
    const bSpin = h('button', { class: 'btn btn-red btn-lg rl-spin', type: 'button', onclick: ready }, 'Spin now');
    const broke = h('div', { class: 'bj-broke' }, h('h3', null, 'Out of tokens!'), h('p', null, 'The house will front you a fresh stack.'), h('button', { class: 'btn btn-red btn-lg', type: 'button', onclick: () => rebuy() }, `Fresh start +${app.meta.rebuy}`));
    const controls = h('div', { class: 'rl-controls' }, timerEl, totalEl, tray.el, h('div', { class: 'rl-adjust' }, bUndo, bClear, bRepeat, bDouble), bSpin, h('div', { class: 'bj-hint' }, 'Tap a number or a line between numbers. Right-click removes a chip. The wheel spins when the clock runs out, or when everyone taps Spin now.'), broke);
    const crowdEl = h('div', { class: 'rl-crowd' });

    root.append(h('div', { class: 'rl' }, h('div', { class: 'rl-left' }, wheelBox, status, histEl, hotEl, crowdEl), h('div', { class: 'rl-right' }, felt, controls)));

    /* ------------------------------------------------ bet logic */
    const open = () => view?.phase === 'betting';
    const total = () => [...bets.values()].reduce((s, b) => s + b.amount, 0);
    const snapshot = () => [...bets.values()].map((b) => ({ ...b, sel: Array.isArray(b.sel) ? [...b.sel] : b.sel }));
    const pushHist = () => {
      hist.push(snapshot());
      if (hist.length > 60) hist.shift();
    };
    const setFrom = (arr) => {
      bets = new Map(arr.map((b) => [betKey(b.type, b.sel), { ...b }]));
    };
    // Chips already on the table are debited on the server, so what I can still add is balance + what I have placed.
    const budget = () => Math.min(app.profile.balance + (view?.me.bets.reduce((s, b) => s + b.amount, 0) ?? 0), view.limits.maxTotal);

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
        const payload = snapshot().map(({ type, sel, amount }) => ({ type, sel, amount }));
        const r = await act({ type: 'setBets', bets: payload });
        if (!r.ok) {
          toast(r.error || 'The croupier could not take those chips.', 'bad');
          setFrom(view.me.bets);
          dirty = false;
          paint();
        }
      }
      pushing = false;
    }
    async function ready() {
      if (!open() || !bets.size) return;
      clearTimeout(edited.t);
      await sync();
      const r = await act({ type: 'ready' });
      if (!r.ok) toast(r.error || 'Not yet.', 'bad');
      else sfx.click();
    }

    function place(type, sel) {
      if (!open() || view.me.ready) return;
      const amt = tray.value;
      if (total() + amt > budget()) return toast(total() + amt > view.limits.maxTotal ? `Maximum ${fmt(view.limits.maxTotal)} tokens per spin.` : 'Not enough tokens for that chip.', 'bad');
      pushHist();
      const key = betKey(type, sel);
      const b = bets.get(key) || { type, sel: Array.isArray(sel) ? [...sel].sort((x, y) => x - y) : sel, amount: 0 };
      b.amount += amt;
      bets.set(key, b);
      sfx.chip();
      edited();
    }
    function removeOne(key) {
      if (!open() || !bets.has(key)) return;
      pushHist();
      const b = bets.get(key);
      b.amount -= tray.value;
      if (b.amount < view.limits.minSpot) bets.delete(key);
      sfx.chip();
      edited();
    }
    function undo() {
      if (!open() || !hist.length) return;
      setFrom(hist.pop());
      sfx.click();
      edited();
    }
    function repeat() {
      if (!open() || !view.me.lastBets.length) return;
      pushHist();
      setFrom(view.me.lastBets);
      trim();
      sfx.chip();
      edited();
    }
    function doubleAll() {
      if (!open() || !bets.size) return;
      if (total() * 2 > budget()) return toast('You cannot double that many chips.', 'bad');
      pushHist();
      bets.forEach((b) => (b.amount *= 2));
      sfx.chip();
      edited();
    }
    function trim() {
      if (total() <= budget()) return;
      for (const k of [...bets.keys()].reverse()) {
        if (total() <= budget()) break;
        bets.delete(k);
      }
      toast('Trimmed your bets to fit your tokens.');
    }

    function paint() {
      if (!view) return;
      stacks.forEach((s) => s.remove());
      stacks.clear();
      for (const [key, b] of bets) {
        const el = anchors.get(key);
        if (!el) continue;
        const s = h('span', { class: 'stk' }, chip(b.amount, 'mini'));
        el.append(s);
        stacks.set(key, s);
      }
      const betting = open();
      const t = total();
      const isBroke = betting && app.profile.canRebuy && !bets.size;
      totalEl.textContent = !betting ? (t ? `Your bet ${fmt(t)}` : 'No more bets') : t ? `Total bet ${fmt(t)}` : 'Place your bets';
      const rdy = view.me.ready;
      const nReady = view.players.filter((p) => p.ready).length;
      bSpin.hidden = !betting;
      bSpin.disabled = !t || rdy;
      bSpin.textContent = rdy ? `Waiting for others (${nReady}/${view.players.length})` : 'Spin now';
      bClear.disabled = !betting || !t || rdy;
      bUndo.disabled = !betting || !hist.length || rdy;
      bRepeat.disabled = !betting || !view.me.lastBets.length || rdy;
      bDouble.disabled = !betting || !t || rdy;
      tray.el.querySelectorAll('button').forEach((b) => (b.disabled = !betting || rdy));
      broke.hidden = !isBroke;
      table.classList.toggle('busy', !betting || rdy);
      const others = view.players.filter((p) => p.id !== app.profile.id);
      crowdEl.replaceChildren(
        ...(others.length
          ? [h('b', null, 'At the wheel'), ...others.map((p) => h('div', { class: 'rl-pl' }, h('span', null, p.name, p.ready && betting ? ' ✓' : ''), h('span', { class: p.net > 0 ? 'up' : p.net < 0 ? 'down' : '' }, view.phase === 'result' && p.net != null ? signed(p.net) : fmt(p.total))))]
          : []),
      );
    }

    function timerPaint() {
      if (!view) return;
      const s = secsLeft(view.deadline);
      let text = '';
      if (view.phase === 'betting') text = view.deadline ? `Bets close in ${s}s` : 'The wheel waits for the first bet';
      else if (view.phase === 'spinning') text = 'No more bets';
      timerEl.textContent = text;
      timerEl.classList.toggle('urgent', view.phase === 'betting' && view.deadline && s <= 5);
    }
    const tid = setInterval(timerPaint, 250);

    /* ------------------------------------------------ result panels */
    function paintHistory() {
      histEl.replaceChildren(...view.history.slice(0, 14).map((n, i) => h('span', { class: `hp ${colorOf(n)} ${i === 0 ? 'new' : ''}` }, String(n))));
      const seen = new Map();
      view.history.forEach((n, i) => !seen.has(n) && seen.set(n, i));
      const freq = new Map();
      view.history.forEach((n) => freq.set(n, (freq.get(n) || 0) + 1));
      const hot = [...freq.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1] || seen.get(a[0]) - seen.get(b[0])).slice(0, 3).map(([n]) => n);
      const cold = [...WHEEL].sort((a, b) => (seen.get(b) ?? 99) - (seen.get(a) ?? 99)).slice(0, 3);
      const pills = (arr) => arr.map((n) => h('span', { class: `hp sm ${colorOf(n)}` }, String(n)));
      hotEl.replaceChildren(
        ...(view.history.length >= 6 ? [h('div', null, h('b', null, 'Hot'), hot.length ? pills(hot) : h('em', null, 'none yet')), h('div', null, h('b', null, 'Cold'), pills(cold))] : []),
      );
    }
    function showHub(n) {
      hub.className = `rl-hub show ${colorOf(n)}`;
      hub.textContent = String(n);
    }
    function clearResult() {
      hub.className = 'rl-hub';
      hl.setAttribute('d', '');
      table.querySelectorAll('.win-cell').forEach((c) => c.classList.remove('win-cell'));
      status.className = 'rl-status';
    }

    /* ------------------------------------------------ the spin */
    function animate(number, ms) {
      return new Promise((resolve) => {
        const target = WHEEL.indexOf(number) * STEP;
        const w0 = wheelAngle;
        const dW = 540;
        const D = 360 * 6;
        const t0 = performance.now();
        let lastIdx = -1;
        let lastTick = 0;
        skip = false;
        const frame = (now) => {
          if (!alive) return resolve();
          let p = Math.min(1, (now - t0) / ms);
          if (skip) p = 1;
          const w = w0 + dW * (1 - (1 - p) ** 2);
          const r = target + D * (1 - p) ** 3;
          let rr = 122 + 24 * Math.max(0, 1 - p / 0.85) ** 2;
          if (p > 0.85 && p < 1) rr += Math.sin(((p - 0.85) / 0.15) * Math.PI * 3) * ((1 - p) / 0.15) * 3.5;
          setWheel(w, r, rr);
          if (p > 0.5 && p < 1 && !skip) {
            const idx = Math.floor((((r % 360) + 360) % 360) / STEP);
            if (idx !== lastIdx && now - lastTick > 55) {
              sfx.tick();
              lastTick = now;
            }
            lastIdx = idx;
          }
          if (p < 1) requestAnimationFrame(frame);
          else {
            wheelAngle = w;
            resolve();
          }
        };
        requestAnimationFrame(frame);
      });
    }

    function landed(number) {
      const i = WHEEL.indexOf(number);
      setWheel(wheelAngle, i * STEP, 122);
      hl.setAttribute('d', pocketPath(i));
      showHub(number);
      cells.get(number)?.classList.add('win-cell');
    }

    function showResult() {
      const r = view.me.result;
      landed(view.number);
      paintHistory();
      for (const b of r?.bets || []) stacks.get(betKey(b.type, b.sel))?.classList.add(b.win ? 'won' : 'lost');
      const word = `${view.number} ${view.color.toUpperCase()}`;
      if (!r) {
        status.className = 'rl-status';
        status.replaceChildren(h('b', null, word), h('span', null, 'Next spin: place your bets'));
        return;
      }
      status.className = `rl-status ${r.net > 0 ? 'win' : r.net < 0 ? 'lose' : ''}`;
      status.replaceChildren(h('b', null, word), h('span', null, r.net > 0 ? `You won ${signed(r.net)}` : r.net < 0 ? `${signed(r.net)} tokens` : 'You broke even'));
    }

    let clockNow = () => Date.now();

    async function onSnap(snap) {
      if (!alive) return;
      const arrived = Date.now();
      clockNow = () => snap.serverNow + (Date.now() - arrived);
      const nv = snap.view;
      prev = view;
      view = nv;
      const phaseChanged = !prev || prev.phase !== nv.phase || prev.round !== nv.round;

      if (nv.phase === 'betting') {
        if (!prev || prev.phase !== 'betting' || prev.round !== nv.round) {
          // new spin: clear the board
          clearResult();
          stacks.forEach((s) => s.classList.remove('won', 'lost'));
          setFrom(nv.me.bets);
          hist = [];
          dirty = false;
          status.textContent = 'Place your bets';
          if (!prev) {
            setWheel(wheelAngle, 0, 146);
            if (nv.history.length) landed(nv.history[0]);
          }
        } else if (!dirty && !pushing) setFrom(nv.me.bets);
        paintHistory();
        paint();
        timerPaint();
        return;
      }

      // spinning or result: the table is closed, the server's bets are the truth
      setFrom(nv.me.bets);
      if (nv.phase === 'spinning') {
        if (phaseChanged && nv.me.bets.length) app.hold = true;
        paint();
        timerPaint();
        if (phaseChanged) {
          const ms = nv.deadline - clockNow();
          spinP = (async () => {
            clearResult();
            status.textContent = 'No more bets...';
            if (!prev || ms < 600) setWheel(wheelAngle, WHEEL.indexOf(nv.number) * STEP, 122);
            else {
              sfx.spin();
              await animate(nv.number, reduceMotion() ? 500 : Math.min(ms, 7000));
            }
          })();
        }
        return;
      }

      // result
      paint();
      timerPaint();
      const mine = nv.me.result;
      await spinP;
      if (!alive || view !== nv) return;
      showResult();
      if (phaseChanged && prev?.phase === 'spinning') {
        if (mine) {
          if (mine.net > 0) celebrate(mine.net, mine.wagered, hub);
          else if (mine.net < 0) sfx.lose();
          if (mine.net !== 0) floatText(hub, signed(mine.net), mine.net < 0 ? 'neg' : '');
        }
      }
      releaseBalance();
    }

    function onKey(e) {
      if (e.target.matches?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.key === 'Enter' || e.key === ' ') && document.activeElement?.tagName !== 'BUTTON') {
        e.preventDefault();
        ready();
      }
    }
    document.addEventListener('keydown', onKey);
    const off = onProfile(() => alive && view && paint());
    onRoom(onSnap);

    return () => {
      alive = false;
      off();
      clearInterval(tid);
      clearTimeout(edited.t);
      document.removeEventListener('keydown', onKey);
      releaseBalance();
    };
  },
};
