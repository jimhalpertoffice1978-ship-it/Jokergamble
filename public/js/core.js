// Shared helpers for the casino shell and every game: DOM builder, API, wallet display,
// synthesised sound, coin showers, toasts, chips. No dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny DOM builder. Strings become text nodes (never HTML), so player names are always safe. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Parse a trusted, static SVG string (never pass user input here). */
export function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export const fmt = (n) => Math.round(n).toLocaleString('en-US');
export const signed = (n) => (n > 0 ? '+' : n < 0 ? '-' : '') + fmt(Math.abs(n));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const ls = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable: carry on */
    }
  },
};

/* ------------------------------------------------------------------ state + wallet */

export const app = {
  token: ls.get('jg.token'),
  meta: null,
  profile: null,
  shown: 0,
  shownInit: false,
  sessionStart: Date.now(),
  sessionNet: 0,
  role: null, // 'player' | 'admin'
  name: '',
  hold: false, // a game is animating a result: keep the balance display where it is
};

const subs = new Set();
export const onProfile = (fn) => (subs.add(fn), () => subs.delete(fn));

/** Store the latest profile. With hold:true the balance display waits for syncBalance(). */
export function setProfile(p, { hold = false } = {}) {
  app.profile = p;
  if (!app.shownInit) {
    app.shown = p.balance;
    app.shownInit = true;
  }
  subs.forEach((f) => f(p));
  if (!hold) syncBalance();
}

const balEls = new Set();
let raf = 0;
export function bindBalance(el) {
  balEls.add(el);
  el.textContent = fmt(app.shown);
  return () => balEls.delete(el);
}
const paint = () => balEls.forEach((el) => (el.textContent = fmt(app.shown)));

export function releaseBalance() {
  app.hold = false;
  if (app.profile) syncBalance();
}

export function syncBalance() {
  const from = app.shown;
  const to = app.profile.balance;
  cancelAnimationFrame(raf);
  if (from === to || reduceMotion()) {
    app.shown = to;
    return paint();
  }
  balEls.forEach((el) => {
    el.classList.remove('gain', 'loss');
    void el.offsetWidth;
    el.classList.add(to > from ? 'gain' : 'loss');
  });
  const t0 = performance.now();
  const dur = Math.min(1100, 300 + Math.abs(to - from) * 0.8);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    app.shown = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    paint();
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

export async function api(path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(app.token ? { authorization: `Bearer ${app.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: 'You seem to be offline. Check your connection.' };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: 'The casino did not answer properly.' };
  }
  data.status = res.status;
  return data;
}

export async function rebuy() {
  const r = await api('/rebuy', {});
  if (r.ok) {
    setProfile(r.profile);
    sfx.coin();
    toast(`Fresh start! The house lends you ${fmt(r.amount)} tokens.`, 'gold');
  } else toast(r.error || 'Could not top up.', 'bad');
  return r;
}

/* ------------------------------------------------------------------ sound (Web Audio, no files) */

let ac = null;
let muted = ls.get('jg.muted') === '1';
export const sound = {
  get muted() {
    return muted;
  },
  toggle() {
    muted = !muted;
    ls.set('jg.muted', muted ? '1' : '0');
    return muted;
  },
};

function audio() {
  if (muted) return null;
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  } catch {
    return null;
  }
}

function tone(freq, dur, { type = 'sine', vol = 0.07, at = 0, to = null } = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}

function noise(dur, { vol = 0.05, at = 0, freq = 3000 } = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
}

export const sfx = {
  chip() {
    tone(1900, 0.06, { type: 'triangle', vol: 0.05 });
    tone(2500, 0.05, { type: 'triangle', vol: 0.03, at: 0.035 });
  },
  card() {
    noise(0.09, { vol: 0.07, freq: 2600 });
  },
  flip() {
    noise(0.12, { vol: 0.06, freq: 1700 });
  },
  click() {
    tone(620, 0.05, { type: 'square', vol: 0.025 });
  },
  win() {
    [523, 659, 784].forEach((f, i) => tone(f, 0.2, { at: i * 0.09, type: 'triangle', vol: 0.07 }));
  },
  big() {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.28, { at: i * 0.08, type: 'triangle', vol: 0.08 }));
  },
  lose() {
    tone(240, 0.4, { type: 'sawtooth', vol: 0.04, to: 110 });
  },
  push() {
    tone(440, 0.16, { vol: 0.06 });
    tone(440, 0.16, { vol: 0.06, at: 0.18 });
  },
  tick() {
    tone(1500, 0.022, { type: 'square', vol: 0.025 });
  },
  spin() {
    noise(0.7, { vol: 0.035, freq: 900 });
  },
  coin() {
    tone(1568, 0.07, { type: 'square', vol: 0.03 });
    tone(2093, 0.14, { type: 'square', vol: 0.03, at: 0.07 });
  },
  level() {
    [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, { at: i * 0.07, type: 'triangle', vol: 0.07 }));
  },
};

/* ------------------------------------------------------------------ effects */

const layer = () => document.getElementById('fx');

export function coinShower(origin, count = 18) {
  if (reduceMotion()) count = Math.min(count, 5);
  const r = origin?.getBoundingClientRect ? origin.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  for (let i = 0; i < count; i++) {
    const c = h('div', { class: 'coin' });
    layer().append(c);
    const dx = (Math.random() - 0.5) * 420;
    const up = 120 + Math.random() * 240;
    const fall = 260 + Math.random() * 260;
    const a = c.animate(
      [
        { transform: `translate(${cx}px, ${cy}px) scale(.5) rotateY(0deg)`, opacity: 1 },
        { transform: `translate(${cx + dx * 0.6}px, ${cy - up}px) scale(1) rotateY(540deg)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${cx + dx}px, ${cy + fall}px) scale(.9) rotateY(1080deg)`, opacity: 0 },
      ],
      { duration: 1100 + Math.random() * 800, easing: 'cubic-bezier(.2,.7,.4,1)', delay: Math.random() * 260, fill: 'both' },
    );
    a.onfinish = () => c.remove();
  }
}

export function floatText(anchor, text, cls = '') {
  const r = anchor.getBoundingClientRect();
  const el = h('div', { class: `floater ${cls}` }, text);
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.top + r.height / 2}px`;
  layer().append(el);
  const a = el.animate(
    [
      { transform: 'translate(-50%, 0) scale(.7)', opacity: 0 },
      { transform: 'translate(-50%, -30px) scale(1.15)', opacity: 1, offset: 0.25 },
      { transform: 'translate(-50%, -90px) scale(1)', opacity: 0 },
    ],
    { duration: 1700, easing: 'ease-out', fill: 'both' },
  );
  a.onfinish = () => el.remove();
}

export function bigBanner(title, amount) {
  const el = h('div', { class: 'bigwin', role: 'status' }, h('div', { class: 'bw-title' }, title), h('div', { class: 'bw-amount' }, `+${fmt(amount)}`));
  layer().append(el);
  const done = () => el.remove();
  el.addEventListener('click', done);
  const a = el.animate(
    [
      { transform: 'translate(-50%, -50%) scale(.3) rotate(-6deg)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1.08) rotate(1deg)', opacity: 1, offset: 0.18 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.8 },
      { transform: 'translate(-50%, -62%) scale(1)', opacity: 0 },
    ],
    { duration: 2600, easing: 'ease-out', fill: 'both' },
  );
  a.onfinish = done;
}

/** Win celebration scaled to the size of the win. Returns the tier: win | big | mega | null. */
export function celebrate(net, wagered, anchor) {
  if (net <= 0) return null;
  const mult = net / Math.max(1, wagered);
  const tier = net >= 5000 || mult >= 10 ? 'mega' : net >= 1000 || mult >= 4 ? 'big' : 'win';
  if (tier === 'win') {
    sfx.win();
    coinShower(anchor, 12);
  } else {
    sfx.big();
    coinShower(anchor, tier === 'mega' ? 70 : 38);
    bigBanner(tier === 'mega' ? 'MEGA WIN' : 'BIG WIN', net);
  }
  return tier;
}

export function toast(msg, kind = '') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3800);
}

export function handleEvents(events = []) {
  events.forEach((e, i) =>
    setTimeout(() => {
      sfx.level();
      if (e.type === 'levelup') toast(`Level ${e.level}! +${fmt(e.reward)} tokens`, 'gold');
      else if (e.type === 'ach') toast(`Achievement: ${e.name}  +${fmt(e.reward)}`, 'gold');
    }, 700 + i * 1100),
  );
}

/* ------------------------------------------------------------------ chips */

const chipTier = (v) => (v >= 1000 ? 'c1000' : v >= 500 ? 'c500' : v >= 100 ? 'c100' : v >= 50 ? 'c50' : 'c10');
export const chipLabel = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : String(v));
export const chip = (v, cls = '') => h('span', { class: `chip ${chipTier(v)} ${cls}` }, h('b', null, chipLabel(v)));

/** Greedy split of an amount into chip denominations (largest first), for stack visuals. */
export function chipsFor(amount, denoms = app.meta?.chips || [10, 50, 100, 500, 1000]) {
  const out = [];
  for (const d of [...denoms].sort((a, b) => b - a)) {
    while (amount >= d && out.length < 40) {
      out.push(d);
      amount -= d;
    }
  }
  if (amount > 0) out.push(Math.max(10, amount));
  return out;
}

/** Row of chip buttons. onPick(value) fires on click; selected state is remembered. */
export function chipTray({ onPick, selectable = false, storeKey = 'jg.chip' }) {
  const chips = app.meta.chips;
  let selected = +ls.get(storeKey);
  if (!chips.includes(selected)) selected = chips[1];
  const wrap = h('div', { class: 'tray', role: 'group', 'aria-label': 'Chips' });
  const btns = chips.map((v) => {
    const b = h('button', { type: 'button', class: 'tray-chip', 'aria-label': `${v} token chip`, onclick: () => pick(v) }, chip(v));
    wrap.append(b);
    return [v, b];
  });
  const mark = () => btns.forEach(([v, b]) => selectable && b.classList.toggle('sel', v === selected));
  function pick(v) {
    selected = v;
    ls.set(storeKey, String(v));
    mark();
    sfx.chip();
    onPick?.(v);
  }
  mark();
  return { el: wrap, get value() { return selected; }, pick };
}

/* ------------------------------------------------------------------ live connection */

const listeners = new Map();
const emit = (type, msg) => (listeners.get(type) || []).forEach((f) => f(msg));

export const net = {
  ws: null,
  offset: 0, // server clock minus local clock
  status: 'idle', // idle | connecting | open | down
  joined: new Set(),
  pending: new Map(),
  rid: 0,
  tries: 0,
  stopped: true,
  tables: [],
  now: () => Date.now() + net.offset,
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type).delete(fn);
  },
  connect() {
    net.stopped = false;
    if (net.ws || !app.token) return;
    net.status = 'connecting';
    emit('status', net.status);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(app.token)}`);
    net.ws = ws;
    ws.onopen = () => {
      net.tries = 0;
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.serverNow) net.offset = m.serverNow - Date.now();
      if (m.t === 'room' && m.snap?.serverNow) net.offset = m.snap.serverNow - Date.now();
      if (m.t === 'hello') {
        net.status = 'open';
        net.tables = m.tables;
        setProfile(m.profile, { hold: app.hold });
        emit('status', net.status);
        for (const g of net.joined) net.raw({ t: 'join', game: g }); // re-take our seat after a reconnect
      } else if (m.t === 'lobby') net.tables = m.tables;
      else if (m.t === 'me') setProfile(m.profile, { hold: app.hold });
      else if (m.t === 'events') handleEvents(m.events);
      else if (m.t === 'ack') {
        const p = net.pending.get(m.rid);
        if (p) {
          net.pending.delete(m.rid);
          p({ ok: m.ok, error: m.error });
        }
      } else if (m.t === 'kicked') {
        net.stopped = true;
        emit('kicked', m);
      }
      emit(m.t, m);
    };
    ws.onclose = () => {
      net.ws = null;
      for (const p of net.pending.values()) p({ ok: false, error: 'Connection lost. Reconnecting...' });
      net.pending.clear();
      if (net.stopped) return;
      net.status = 'down';
      emit('status', net.status);
      setTimeout(() => net.connect(), Math.min(8000, 400 * 2 ** net.tries++));
    };
  },
  disconnect() {
    net.stopped = true;
    net.joined.clear();
    net.ws?.close();
    net.ws = null;
    net.status = 'idle';
  },
  raw(o) {
    if (net.ws?.readyState === 1) net.ws.send(JSON.stringify(o));
  },
  join(game) {
    net.joined.add(game);
    net.raw({ t: 'join', game });
  },
  leave(game) {
    net.joined.delete(game);
    net.raw({ t: 'leave', game });
  },
  act(game, action) {
    if (net.ws?.readyState !== 1) return Promise.resolve({ ok: false, error: 'Not connected yet. One moment...' });
    const rid = ++net.rid;
    return new Promise((resolve) => {
      net.pending.set(rid, resolve);
      net.raw({ t: 'act', game, rid, action });
      setTimeout(() => net.pending.delete(rid) && resolve({ ok: false, error: 'The table did not answer.' }), 8000);
    });
  },
};

/** Seconds left until a server timestamp, never negative. */
export const secsLeft = (deadline) => (deadline ? Math.max(0, Math.ceil((deadline - net.now()) / 1000)) : null);

export async function login(id, password) {
  const r = await api('/login', { id, password });
  if (!r.ok) return r;
  app.token = r.token;
  app.role = r.role;
  app.name = r.name;
  ls.set('jg.token', r.token);
  if (r.profile) setProfile(r.profile);
  return r;
}

export async function logout() {
  await api('/logout', {});
  ls.set('jg.token', '');
  net.disconnect();
  location.hash = '#/';
  location.reload();
}
