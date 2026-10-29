// Host console: create and manage player accounts, flip house switches, reset tables, read the audit log.
import { h, api, fmt, toast } from './core.js';

const rel = (t) => {
  if (!t) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

const genPassword = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint32Array(10);
  crypto.getRandomValues(a);
  return [...a].map((n) => abc[n % abc.length]).join('');
};

/** Small modal form. fields: [{key,label,type,value,hint}]. Resolves with values or null. */
function ask(title, fields, { confirm = 'Save', danger = false, note = '' } = {}) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => h('input', { class: 'field', type: f.type || 'text', value: f.value ?? '', placeholder: f.hint || '', autocomplete: 'off', 'aria-label': f.label }));
    const done = (v) => {
      modal.remove();
      resolve(v);
    };
    const form = h(
      'form',
      {
        class: 'modal-card',
        onsubmit: (e) => {
          e.preventDefault();
          done(Object.fromEntries(fields.map((f, i) => [f.key, inputs[i].value])));
        },
      },
      h('h2', null, title),
      note ? h('p', null, note) : null,
      h('div', { class: 'stack-form' }, fields.map((f, i) => h('label', { class: 'lab' }, h('span', null, f.label), inputs[i]))),
      h('div', { class: 'row' }, h('button', { class: `btn ${danger ? 'btn-red' : ''}`, type: 'submit' }, confirm), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => done(null) }, 'Cancel')),
    );
    const modal = h('div', { class: 'modal', onkeydown: (e) => e.key === 'Escape' && done(null) }, form);
    document.body.append(modal);
    inputs[0]?.focus();
  });
}

export default {
  mount(root) {
    let alive = true;
    let data = null;

    const tablesEl = h('div', { class: 'ad-tables' });
    const switchesEl = h('div', { class: 'ad-switches' });
    const listEl = h('div', { class: 'ad-list' });
    const auditEl = h('ol', { class: 'ad-audit' });
    const countEl = h('small');

    /* ---- create form ---- */
    const fId = h('input', { class: 'field', placeholder: 'player id (a-z, 0-9)', maxlength: 20, autocomplete: 'off', 'aria-label': 'New player id' });
    const fName = h('input', { class: 'field', placeholder: 'display name (optional)', maxlength: 16, autocomplete: 'off', 'aria-label': 'Display name' });
    const fPw = h('input', { class: 'field', placeholder: 'password (6+ chars)', maxlength: 64, autocomplete: 'off', 'aria-label': 'Password', value: genPassword() });
    const fBal = h('input', { class: 'field', type: 'number', min: 0, step: 100, value: 1000, 'aria-label': 'Starting tokens' });
    const create = h(
      'form',
      {
        class: 'ad-create',
        onsubmit: async (e) => {
          e.preventDefault();
          const body = { id: fId.value, password: fPw.value, name: fName.value || undefined, balance: Number(fBal.value) };
          const r = await api('/admin/accounts', body);
          if (!r.ok) return toast(r.error || 'Could not create the account.', 'bad');
          await ask('Account created', [{ key: 'x', label: 'Give the player these details', value: `ID: ${body.id}   Password: ${body.password}` }], { confirm: 'Done', note: 'Copy these now. Passwords are stored hashed, so you will not be able to read this one again (you can always set a new one).' });
          fId.value = fName.value = '';
          fPw.value = genPassword();
          refresh();
        },
      },
      fId,
      fName,
      fPw,
      fBal,
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => (fPw.value = genPassword()) }, 'New password'),
      h('button', { class: 'btn', type: 'submit' }, 'Create player'),
    );

    root.replaceChildren(
      h('section', { class: 'hero' }, h('h1', null, 'Host console'), h('p', null, 'You control every account and table. Players cannot sign up on their own: create their ID and password here.')),
      h('div', { class: 'sec-title' }, 'Tables'),
      tablesEl,
      h('div', { class: 'sec-title' }, 'House switches'),
      switchesEl,
      h('div', { class: 'sec-title' }, 'New player'),
      create,
      h('div', { class: 'sec-title' }, 'Players', countEl),
      listEl,
      h('div', { class: 'sec-title' }, 'Activity log'),
      auditEl,
    );

    const call = async (path, body, ok) => {
      const r = await api(path, body);
      if (!r.ok) toast(r.error || 'That did not work.', 'bad');
      else if (ok) toast(ok, 'gold');
      refresh();
      return r;
    };

    function row(a) {
      const act = (label, fn, cls = 'btn-ghost') => h('button', { class: `btn btn-sm ${cls}`, type: 'button', onclick: fn }, label);
      return h(
        'div',
        { class: `ad-row ${a.disabled ? 'off' : ''}` },
        h('div', { class: 'ad-who' }, h('b', null, a.name), h('small', null, `@${a.id}`), a.online ? h('span', { class: 'pill on' }, 'online') : null, a.disabled ? h('span', { class: 'pill off' }, 'switched off') : null, a.staked ? h('span', { class: 'pill' }, `${fmt(a.staked)} on table`) : null),
        h('div', { class: 'ad-num' }, h('b', null, fmt(a.balance)), h('small', null, 'tokens')),
        h('div', { class: 'ad-num' }, h('b', null, `Lv ${a.level}`), h('small', null, `${fmt(a.rounds)} rounds`)),
        h('div', { class: 'ad-num' }, h('b', { class: a.net < 0 ? 'neg' : '' }, (a.net > 0 ? '+' : '') + fmt(a.net)), h('small', null, 'net')),
        h('div', { class: 'ad-num' }, h('b', null, rel(a.lastLogin)), h('small', null, 'last seen')),
        h(
          'div',
          { class: 'ad-act' },
          act('Tokens', async () => {
            const v = await ask(`Tokens for ${a.name}`, [{ key: 'v', label: 'Amount', type: 'number', hint: 'e.g. 500' }, { key: 'mode', label: 'Type "set" to replace the balance, or leave empty to add (use a minus to remove)', value: '' }], { confirm: 'Apply', note: `Current balance: ${fmt(a.balance)}` });
            if (!v || v.v === '') return;
            const n = Number(v.v);
            call(`/admin/accounts/${a.id}/balance`, v.mode.trim().toLowerCase() === 'set' ? { set: n } : { add: n }, 'Balance updated.');
          }),
          act('Password', async () => {
            const v = await ask(`New password for ${a.name}`, [{ key: 'password', label: 'Password', value: genPassword() }], { confirm: 'Set password', note: 'The player is signed out everywhere. Tell them the new password.' });
            if (v) call(`/admin/accounts/${a.id}/password`, { password: v.password }, `Password changed for ${a.id}.`);
          }),
          act('Rename', async () => {
            const v = await ask(`Display name for @${a.id}`, [{ key: 'name', label: 'Name', value: a.name }]);
            if (v) call(`/admin/accounts/${a.id}/name`, { name: v.name }, 'Renamed.');
          }),
          act(a.disabled ? 'Switch on' : 'Switch off', () => call(`/admin/accounts/${a.id}/disable`, { disabled: !a.disabled }, a.disabled ? 'Account is back on.' : 'Account switched off and signed out.')),
          act('Sign out', () => call(`/admin/accounts/${a.id}/kick`, {}, 'Signed out.')),
          act(
            'Delete',
            async () => {
              const v = await ask(`Delete ${a.name}?`, [{ key: 'ok', label: `Type ${a.id} to confirm` }], { confirm: 'Delete forever', danger: true, note: 'Their balance, stats and achievements are removed for good.' });
              if (v && v.ok.trim().toLowerCase() === a.id) call(`/admin/accounts/${a.id}/delete`, {}, 'Account deleted.');
            },
            'btn-ghost danger',
          ),
        ),
      );
    }

    function paint() {
      if (!data) return;
      countEl.textContent = `${data.accounts.length} accounts, ${data.accounts.filter((a) => a.online).length} online`;
      tablesEl.replaceChildren(
        ...data.tables.map((t) =>
          h(
            'div',
            { class: 'ad-table' },
            h('b', null, t.name),
            h('span', null, `${t.phase}, round ${t.round}`),
            h('span', null, `${t.seated} playing, ${t.online} watching`),
            h(
              'button',
              {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                onclick: async () => {
                  const v = await ask(`Reset ${t.name}?`, [], { confirm: 'Reset table', danger: true, note: 'Every stake on the table is refunded and the table starts a fresh round. Use this if a table is ever stuck.' });
                  if (v) call(`/admin/tables/${t.id}/reset`, {}, `${t.name} reset, stakes refunded.`);
                },
              },
              'Reset',
            ),
          ),
        ),
      );
      const sw = (key, label, hint) =>
        h(
          'label',
          { class: 'switch' },
          h('input', { type: 'checkbox', checked: data.settings[key] || null, onchange: (e) => call('/admin/settings', { [key]: e.target.checked }, 'Saved.') }),
          h('span', null, h('b', null, label), h('small', null, hint)),
        );
      switchesEl.replaceChildren(sw('dailyBonus', 'Daily bonus', 'Players can claim free tokens once a day.'), sw('freshStart', 'Fresh start', 'Broke players can take a small top-up.'));
      if (!document.querySelector('.modal')) {
        listEl.replaceChildren(...(data.accounts.length ? data.accounts.map(row) : [h('p', { class: 'empty' }, 'No players yet. Create the first account above.')]));
      }
      auditEl.replaceChildren(...data.audit.map((e) => h('li', null, h('time', null, rel(e.t)), h('span', null, `${e.actor} ${e.action} ${e.target}${e.detail ? ` (${e.detail})` : ''}`))));
    }

    async function refresh() {
      const r = await api('/admin/overview');
      if (!alive) return;
      if (r.ok) {
        data = r;
        paint();
      }
    }
    refresh();
    const t = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  },
};
