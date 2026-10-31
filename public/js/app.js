// JokerGamble shell: sign-in, header, lobby, router, and the hand-off to each game module.
import { app, h, $, api, setProfile, onProfile, bindBalance, fmt, signed, ls, sound, sfx, toast, coinShower, rebuy, net, login, logout, secsLeft } from './core.js';

const HAT = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="hg" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#ffe9a0"/><stop offset=".6" stop-color="#f6c744"/><stop offset="1" stop-color="#b87a14"/></radialGradient></defs><path d="M10 42 L17 14 L28 29 L32 10 L36 29 L47 14 L54 42 Z" fill="url(#hg)"/><rect x="10" y="42" width="44" height="8" rx="4" fill="#d4202f"/><circle cx="17" cy="14" r="4" fill="#ffe9a0"/><circle cx="32" cy="10" r="4" fill="#ffe9a0"/><circle cx="47" cy="14" r="4" fill="#ffe9a0"/></svg>`;
const ICON_ON = `<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`;
const ICON_OFF = `<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>`;
const htmlIcon = (s) => {
  const t = document.createElement('template');
  t.innerHTML = s;
  return t.content.firstElementChild;
};

let stage;
let cleanup = null;
let routeId = 0;
let ui = {};

/* ------------------------------------------------------------------ boot */

async function boot() {
  app.meta = await api('/meta');
  if (!app.meta.ok) {
    $('#app').replaceChildren(h('p', { class: 'loading' }, 'The casino is closed right now. Please try again in a minute.'));
    return;
  }
  if (app.token) {
    const me = await api('/me');
    if (me.ok) {
      app.role = me.role;
      app.name = me.name;
      if (me.profile) setProfile(me.profile);
    } else {
      app.token = null;
      ls.set('jg.token', '');
    }
  }
  if (!app.token) await welcome();
  app.startBal = app.profile?.balance ?? 0;
  buildShell();
  window.addEventListener('hashchange', route);
  const hdr = document.querySelector('header.top');
  const setHdr = () => document.body.style.setProperty('--hdr', `${hdr.offsetHeight}px`);
  new ResizeObserver(setHdr).observe(hdr);
  setHdr();
  if (app.role === 'player') {
    onProfile(updateHeader);
    updateHeader(app.profile);
    net.on('kicked', (m) => kicked(m.reason));
    net.on('status', paintConn);
    net.on('lobby', () => liveLobby?.());
    net.on('hello', () => liveLobby?.());
    net.connect();
    setInterval(() => updateHeader(app.profile), 30_000);
    setInterval(realityTick, 15_000);
  }
  route();
}

function kicked(reason) {
  ls.set('jg.token', '');
  net.disconnect();
  const modal = h('div', { class: 'modal' }, h('div', { class: 'modal-card' }, h('h2', null, 'Signed out'), h('p', null, reason || 'Please sign in again.'), h('button', { class: 'btn btn-lg', type: 'button', onclick: () => location.reload() }, 'Back to sign in')));
  document.body.append(modal);
}

function welcome() {
  return new Promise((resolve) => {
    const id = h('input', { class: 'field', maxlength: 20, placeholder: 'Player ID', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Player ID', value: ls.get('jg.id') || '' });
    const pw = h('input', { class: 'field', type: 'password', maxlength: 64, placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const err = h('p', { class: 'form-err', role: 'alert' });
    const btn = h('button', { class: 'btn btn-lg', type: 'submit' }, 'Take your seat');
    const form = h(
      'form',
      {
        class: 'modal-card',
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          err.textContent = '';
          const r = await login(id.value, pw.value);
          if (!r.ok) {
            err.textContent = r.error || 'Could not sign in.';
            btn.disabled = false;
            pw.select();
            return;
          }
          ls.set('jg.id', id.value.trim().toLowerCase());
          modal.remove();
          resolve();
        },
      },
      htmlIcon(HAT.replace('<svg ', '<svg style="width:70px;height:70px;margin-bottom:6px" ')),
      h('h2', null, 'JokerGamble'),
      h('p', null, 'Members only. Your host creates your ID and password. You play with free tokens only: no real money, no purchases, no cash-outs. Ever.'),
      h('div', { class: 'stack-form' }, id, pw, err, btn),
    );
    const modal = h('div', { class: 'modal' }, form);
    document.body.append(modal);
    (id.value ? pw : id).focus();
  });
}

/* ------------------------------------------------------------------ shell */

function buildShell() {
  const admin = app.role === 'admin';
  const balNum = h('span', { class: 'bal-num' });
  bindBalance(balNum);
  ui.lv = h('span', { class: 'lv-badge' });
  ui.bar = h('i');
  ui.tier = h('span', { class: 'tier' });
  ui.daily = h('button', { class: 'btn btn-sm daily', type: 'button', onclick: onDaily });
  ui.mute = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Toggle sound', onclick: toggleSound });
  ui.session = h('span');
  ui.conn = h('span', { class: 'conn', title: 'Connecting...' });
  ui.who = h('span', { class: 'who' }, ui.conn, admin ? 'Host' : app.profile?.name || app.name);
  ui.logout = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: logout }, 'Sign out');
  paintMute();

  stage = h('main', { class: 'wrap', id: 'stage' });
  $('#app').replaceChildren(
    h(
      'header',
      { class: 'top' },
      h(
        'div',
        { class: 'top-in' },
        h('a', { class: 'brand', href: '#/', 'aria-label': 'JokerGamble home' }, htmlIcon(HAT), h('span', { class: 'brand-text' }, 'Joker', h('em', null, 'Gamble'))),
        admin ? h('div', { class: 'rank' }, h('span', { class: 'tier t-gold' }, 'Host console')) : h('div', { class: 'rank' }, ui.lv, h('div', { class: 'lv-bar' }, h('div', { class: 'bar' }, ui.bar)), ui.tier),
        admin ? null : ui.daily,
        admin ? null : h('div', { class: 'bal' }, h('span', { class: 'coin-ico' }), h('div', null, h('span', { class: 'bal-lab' }, 'Tokens'), balNum)),
        ui.who,
        ui.mute,
        ui.logout,
      ),
      h('div', { class: 'bulbs' }),
    ),
    stage,
    h(
      'footer',
      null,
      h('div', null, h('b', null, 'Play tokens only.'), ' No real money, no purchases, no cash-outs. For fun, 18+. If it stops being fun, take a break.'),
      h('div', null, ui.session),
    ),
  );
}

function paintConn(status) {
  if (!ui.conn) return;
  ui.conn.className = `conn ${status}`;
  ui.conn.title = status === 'open' ? 'Live' : status === 'down' ? 'Reconnecting...' : 'Connecting...';
}

function paintMute() {
  ui.mute.replaceChildren(htmlIcon(sound.muted ? ICON_OFF : ICON_ON));
  ui.mute.title = sound.muted ? 'Sound off' : 'Sound on';
}
function toggleSound() {
  sound.toggle();
  paintMute();
  sfx.click();
}

function countdown(ms) {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function updateHeader(p) {
  if (!p || !ui.lv) return;
  ui.lv.textContent = `Lv ${p.level}`;
  ui.bar.style.width = `${Math.min(100, ((p.xp - p.xpFloor) / (p.xpNext - p.xpFloor)) * 100)}%`;
  ui.tier.className = `tier t-${p.tier.id}`;
  ui.tier.textContent = p.tier.name;
  const d = ui.daily;
  d.hidden = false;
  if (p.canRebuy) {
    d.dataset.mode = 'rebuy';
    d.disabled = false;
    d.className = 'btn btn-sm daily ready btn-red';
    d.textContent = `Fresh start +${app.meta.rebuy}`;
  } else if (!p.daily.enabled) {
    d.hidden = true;
  } else if (p.daily.available) {
    d.dataset.mode = 'daily';
    d.disabled = false;
    d.className = 'btn btn-sm daily ready';
    d.textContent = `Daily bonus +${p.daily.amount}`;
  } else {
    d.dataset.mode = 'wait';
    d.disabled = true;
    d.className = 'btn btn-sm btn-ghost daily';
    d.textContent = `Next bonus ${countdown(p.daily.next - Date.now())}`;
  }
  const mins = Math.floor((Date.now() - app.sessionStart) / 60_000);
  ui.session.textContent = `Session ${mins} min, ${signed(p.balance - app.startBal)} tokens`;
}

async function onDaily() {
  if (ui.daily.dataset.mode === 'rebuy') return rebuy();
  const r = await api('/daily', {});
  if (!r.ok) return toast(r.error || 'Not ready yet.', 'bad');
  setProfile(r.profile);
  sfx.coin();
  coinShower(ui.daily, 26);
  toast(`Daily bonus: +${fmt(r.amount)} tokens. Day ${r.streak} streak!`, 'gold');
}

/* ------------------------------------------------------------------ responsible play */

let nextCheck = Date.now() + 30 * 60_000;
function realityTick() {
  if (Date.now() < nextCheck || document.querySelector('.modal')) return;
  nextCheck = Date.now() + 30 * 60_000;
  const mins = Math.round((Date.now() - app.sessionStart) / 60_000);
  const close = () => modal.remove();
  const modal = h(
    'div',
    { class: 'modal' },
    h(
      'div',
      { class: 'modal-card', role: 'dialog', 'aria-label': 'Break reminder' },
      h('h2', null, 'Quick breather?'),
      h('p', null, `You have been at the tables for ${mins} minutes. Session result: ${signed((app.profile?.balance ?? 0) - app.startBal)} tokens. They are only play tokens, but the best sessions have an end.`),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Keep playing'),
        h(
          'button',
          {
            class: 'btn btn-ghost',
            type: 'button',
            onclick: () => {
              close();
              location.hash = '#/';
            },
          },
          'Take a break',
        ),
      ),
    ),
  );
  document.body.append(modal);
}

/* ------------------------------------------------------------------ router */

let liveLobby = null;

async function route() {
  const my = ++routeId;
  liveLobby = null;
  if (cleanup) {
    try {
      cleanup();
    } catch (e) {
      console.error(e);
    }
    cleanup = null;
  }
  window.scrollTo(0, 0);
  document.body.classList.toggle('in-game', app.role === 'player' && /^#\/g\//.test(location.hash));
  if (app.role === 'admin') {
    stage.replaceChildren(h('div', { class: 'loading' }, 'Opening the host console...'));
    const mod = await import('./admin.js');
    if (my !== routeId) return;
    cleanup = mod.default.mount(stage);
    return;
  }
  const m = location.hash.match(/^#\/g\/([a-z0-9-]+)/);
  if (m) await openGame(m[1], my);
  else lobby();
}

function ensureCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', href }));
}

async function openGame(id, my) {
  const g = app.meta.games.find((x) => x.id === id);
  if (!g) {
    location.hash = '#/';
    return;
  }
  stage.replaceChildren(h('div', { class: 'loading' }, 'Pulling up a chair...'));
  ensureCss(`/games/${id}.css`);
  let mod;
  try {
    mod = await import(`/games/${id}.js`);
  } catch (e) {
    console.error(e);
    toast('This table is closed for now.', 'bad');
    location.hash = '#/';
    return;
  }
  if (my !== routeId) return;
  const root = h('section', { class: `game game-${id}` });
  const crowd = h('span', { class: 'crowd' });
  stage.replaceChildren(h('div', { class: 'crumbs' }, h('a', { class: 'btn btn-ghost btn-sm', href: '#/' }, 'Lobby'), h('h1', null, g.name), crowd), root);
  const offs = [];
  const ctx = {
    meta: g,
    act: (action) => net.act(id, action),
    onRoom(fn) {
      offs.push(
        net.on('room', (m) => {
          if (m.game !== id) return;
          crowd.textContent = `${m.snap.people.length} at the table`;
          fn(m.snap);
        }),
      );
    },
  };
  const fn = await mod.default.mount(root, ctx);
  if (my !== routeId) {
    fn?.();
    return;
  }
  net.join(id);
  cleanup = () => {
    offs.forEach((o) => o());
    net.leave(id);
    fn?.();
  };
}

/* ------------------------------------------------------------------ lobby */

const PHASE = {
  betting: 'Betting open',
  playing: 'Cards in play',
  spinning: 'Wheel spinning',
  selling: 'Tickets on sale',
  drawing: 'Drawing now',
  result: 'Paying out',
};

function lobby() {
  const p = app.profile;
  const first = app.meta.games[0];
  const live = new Map(); // game id -> {pop, line}
  const tiles = app.meta.games.map((g) => {
    const pop = h('span', { class: 'pop' }, '...');
    const line = h('span', { class: 'phase' });
    live.set(g.id, { pop, line });
    return h(
      'a',
      { class: 'tile', href: `#/g/${g.id}`, style: { '--acc': g.accent } },
      h('img', { src: `/games/${g.id}.svg`, alt: '', width: 400, height: 240 }),
      h(
        'div',
        { class: 'tile-body' },
        h('h3', null, g.name),
        h('p', null, g.tagline),
        h('div', { class: 'tile-live' }, pop, line),
        h('ul', { class: 'rules' }, g.rules.map((r) => h('li', null, r))),
        h('span', { class: 'btn' }, 'Join the table'),
      ),
    );
  });
  tiles.push(h('div', { class: 'tile soon' }, h('div', null, h('h3', null, 'More tables soon'), h('p', null, 'New games are on the way.'))));

  liveLobby = () => {
    for (const t of net.tables) {
      const el = live.get(t.id);
      if (!el) continue;
      const left = secsLeft(t.deadline);
      el.pop.textContent = t.online ? `${t.online} watching` : 'Empty table';
      const base = PHASE[t.phase] || '';
      const jp = t.jackpot ? ` · Jackpot ${fmt(t.jackpot)}` : '';
      el.line.textContent = (t.seated ? `${base}${left != null ? ` · ${left}s` : ''} · ${t.seated} playing` : t.phase === 'betting' || t.phase === 'selling' ? 'Waiting for the first bet' : base) + jp;
    }
  };
  liveLobby();
  const timer = setInterval(() => liveLobby?.(), 500);
  cleanup = () => clearInterval(timer);

  const boardList = h('ol', { class: 'board' }, h('li', null, h('span'), h('span', { class: 'nm' }, 'Counting the chips...'), h('span')));
  const board = h('div', { class: 'panel' }, h('h2', null, 'High Rollers'), boardList);
  const loadBoard = () =>
    api('/leaderboard').then((r) => {
      if (!r.ok) return boardList.replaceChildren();
      boardList.replaceChildren(
        ...r.top.map((q, i) => h('li', { class: q.id === r.me.id ? 'me' : '' }, h('span', { class: 'n' }, i + 1), h('span', { class: 'nm' }, q.name, h('small', null, q.tier)), h('span', { class: 'v' }, fmt(q.balance)))),
      );
      if (!r.top.some((q) => q.id === r.me.id)) {
        boardList.append(h('li', { class: 'me' }, h('span', { class: 'n' }, '#'), h('span', { class: 'nm' }, `You are ranked ${r.me.rank} of ${r.players}`), h('span')));
      }
    });
  loadBoard();
  const boardTimer = setInterval(loadBoard, 15_000);
  const stop = cleanup;
  cleanup = () => {
    stop();
    clearInterval(boardTimer);
  };

  const s = p.stats;
  const decided = s.wins + s.losses + s.pushes;
  const toNext = p.nextTier ? `${fmt(s.wagered)} / ${fmt(p.nextTier.at)} wagered to ${p.nextTier.name}` : 'Top tier reached';
  const progress = h(
    'div',
    { class: 'panel' },
    h('h2', null, 'Your Progress'),
    h('div', { class: 'prog-line' }, h('span', null, `Level ${p.level}`), h('span', null, `${fmt(p.xp - p.xpFloor)} / ${fmt(p.xpNext - p.xpFloor)} XP`)),
    h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, ((p.xp - p.xpFloor) / (p.xpNext - p.xpFloor)) * 100)}%` } })),
    h('div', { class: 'prog-line' }, h('span', { class: `tier t-${p.tier.id}` }, `${p.tier.name} member`), h('span', null, toNext)),
    h(
      'div',
      { class: 'stats' },
      stat(fmt(s.rounds), 'Rounds'),
      stat(decided ? `${Math.round((s.wins / decided) * 100)}%` : '-', 'Win rate'),
      stat(fmt(s.biggestWin), 'Biggest win'),
      stat(fmt(s.bestStreak), 'Best streak'),
      stat(fmt(s.wagered), 'Wagered'),
      stat(fmt(s.rebuys), 'Fresh starts'),
    ),
  );

  const achs = h(
    'div',
    { class: 'achs' },
    app.meta.achievements.map((a) =>
      h('div', { class: `ach ${p.ach.includes(a.id) ? '' : 'locked'}` }, h('span', { class: 'medal' }, '★'), h('div', null, h('b', null, a.name), h('span', null, `${a.desc}  (+${fmt(a.reward)})`))),
    ),
  );

  stage.replaceChildren(
    h(
      'section',
      { class: 'hero' },
      h('h1', null, `Welcome back, ${p.name}`),
      h('p', null, 'The tables never close. Every game has one shared room, so you play alongside everyone else who is here. All play money.'),
      h('div', { class: 'hero-actions' }, h('a', { class: 'btn btn-lg', href: `#/g/${first.id}` }, `Join ${first.name}`), app.meta.games[1] ? h('a', { class: 'btn btn-ghost btn-lg', href: `#/g/${app.meta.games[1].id}` }, `Join ${app.meta.games[1].name}`) : null),
    ),
    h('div', { class: 'sec-title' }, 'The Tables', h('small', null, `${app.meta.games.length} open`)),
    h('div', { class: 'tiles' }, tiles),
    h('div', { class: 'two' }, progress, board),
    h('div', { class: 'sec-title' }, 'Achievements', h('small', null, `${p.ach.length} / ${app.meta.achievements.length}`)),
    achs,
  );
}

const stat = (v, l) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, l));

boot();
