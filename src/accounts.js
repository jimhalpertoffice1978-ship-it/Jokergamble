// Accounts are created and controlled by the host. Passwords are stored as salted scrypt hashes,
// sessions as SHA-256 of the token. The admin login is static (from the environment).
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { START_BALANCE } from './config.js';
import { blankStats } from './progression.js';

const scrypt = promisify(crypto.scrypt);
const ID_RE = /^[a-z0-9][a-z0-9_.-]{2,19}$/;
const SESSION_TTL = 30 * 24 * 3600e3;
const MAX_SESSIONS = 8;
const MAX_BALANCE = 1_000_000_000;

export const cleanName = (raw) =>
  String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, 32);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
const sameHash = (a, b) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export class Accounts {
  constructor({ db, now = () => Date.now(), adminId, adminPassword }) {
    this.db = db;
    this.now = now;
    this.adminId = String(adminId).trim().toLowerCase();
    this.adminPassword = adminPassword;
    this.adminCred = null;
    this.dummy = null;
  }

  async init() {
    this.adminCred = await hashPassword(this.adminPassword);
    this.dummy = await hashPassword('not-a-real-password');
    this.pruneSessions();
  }

  get(id) {
    return this.db.data.accounts[String(id)] || null;
  }
  list() {
    return Object.values(this.db.data.accounts);
  }

  validateId(id) {
    const v = String(id ?? '').trim().toLowerCase();
    if (!ID_RE.test(v)) return { error: 'Id must be 3-20 characters: letters, numbers, dot, dash or underscore.' };
    if (v === this.adminId) return { error: 'That id is reserved.' };
    return { id: v };
  }
  validatePassword(pw) {
    if (typeof pw !== 'string' || pw.length < 6 || pw.length > 64) return 'Password must be 6 to 64 characters.';
    return null;
  }

  async create({ id, password, name, balance }) {
    const v = this.validateId(id);
    if (v.error) return { ok: false, error: v.error };
    const pe = this.validatePassword(password);
    if (pe) return { ok: false, error: pe };
    if (this.get(v.id)) return { ok: false, error: 'That id already exists.' };
    const bal = balance === undefined || balance === '' ? START_BALANCE : Number(balance);
    if (!Number.isInteger(bal) || bal < 0 || bal > MAX_BALANCE) return { ok: false, error: 'Starting tokens must be a whole number from 0 to 1,000,000,000.' };
    const { salt, hash } = await hashPassword(password);
    const t = this.now();
    const acc = {
      id: v.id,
      name: cleanName(name) || v.id,
      salt,
      hash,
      balance: bal,
      xp: 0,
      stats: blankStats(),
      ach: {},
      daily: { last: 0, next: 0, streak: 0 },
      disabled: false,
      createdAt: t,
      lastLogin: 0,
    };
    this.db.data.accounts[v.id] = acc;
    this.db.dirty();
    return { ok: true, account: acc };
  }

  async setPassword(id, password) {
    const a = this.get(id);
    if (!a) return { ok: false, error: 'No such account.' };
    const pe = this.validatePassword(password);
    if (pe) return { ok: false, error: pe };
    Object.assign(a, await hashPassword(password));
    this.revokeAccount(id); // changing a password signs the player out everywhere
    this.db.dirty();
    return { ok: true };
  }

  setBalance(id, { set, add }) {
    const a = this.get(id);
    if (!a) return { ok: false, error: 'No such account.' };
    let next;
    if (set !== undefined) next = Number(set);
    else if (add !== undefined) next = a.balance + Number(add);
    else return { ok: false, error: 'Give a new balance or an amount to add.' };
    if (!Number.isInteger(next) || next < 0 || next > MAX_BALANCE) return { ok: false, error: 'Balance must be a whole number from 0 to 1,000,000,000.' };
    const before = a.balance;
    a.balance = next;
    this.db.dirty();
    return { ok: true, before, after: next };
  }

  rename(id, name) {
    const a = this.get(id);
    const n = cleanName(name);
    if (!a || !n) return { ok: false, error: 'Give a display name.' };
    a.name = n;
    this.db.dirty();
    return { ok: true };
  }

  setDisabled(id, disabled) {
    const a = this.get(id);
    if (!a) return { ok: false, error: 'No such account.' };
    a.disabled = !!disabled;
    if (a.disabled) this.revokeAccount(id);
    this.db.dirty();
    return { ok: true };
  }

  remove(id) {
    if (!this.get(id)) return { ok: false, error: 'No such account.' };
    delete this.db.data.accounts[id];
    this.revokeAccount(id);
    this.db.dirty();
    return { ok: true };
  }

  /** Check an id and password. Returns {ok, role, id} without creating a session. */
  async verify(id, password) {
    const norm = String(id ?? '').trim().toLowerCase();
    const pw = String(password ?? '').slice(0, 200);
    if (norm === this.adminId) {
      const h = await hashPassword(pw, this.adminCred.salt);
      return sameHash(h.hash, this.adminCred.hash) ? { ok: true, role: 'admin', id: this.adminId } : { ok: false, error: 'Wrong id or password.' };
    }
    const a = this.get(norm);
    const cred = a || this.dummy; // same work whether or not the id exists
    const h = await hashPassword(pw, cred.salt);
    if (!a || !sameHash(h.hash, cred.hash)) return { ok: false, error: 'Wrong id or password.' };
    if (a.disabled) return { ok: false, error: 'This account is switched off. Please ask the host.' };
    return { ok: true, role: 'player', id: a.id };
  }

  createSession(id, role) {
    const token = crypto.randomBytes(24).toString('hex');
    const t = this.now();
    const sessions = this.db.data.sessions;
    sessions[sha(token)] = { id, role, exp: t + SESSION_TTL };
    const mine = Object.entries(sessions).filter(([, s]) => s.id === id).sort((a, b) => a[1].exp - b[1].exp);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS))) delete sessions[k];
    if (role === 'player') this.get(id).lastLogin = t;
    this.db.dirty();
    return token;
  }

  /** Look up a session token. Returns {id, role, account?} or null. */
  session(token) {
    if (typeof token !== 'string' || !token) return null;
    const s = this.db.data.sessions[sha(token)];
    if (!s || s.exp < this.now()) return null;
    if (s.role === 'admin') return { id: s.id, role: 'admin' };
    const a = this.get(s.id);
    if (!a || a.disabled) return null;
    return { id: s.id, role: 'player', account: a };
  }

  revokeToken(token) {
    delete this.db.data.sessions[sha(String(token))];
    this.db.dirty();
  }
  revokeAccount(id) {
    for (const [k, s] of Object.entries(this.db.data.sessions)) if (s.id === id) delete this.db.data.sessions[k];
    this.db.dirty();
  }
  pruneSessions() {
    const t = this.now();
    for (const [k, s] of Object.entries(this.db.data.sessions)) if (s.exp < t) delete this.db.data.sessions[k];
  }
}
