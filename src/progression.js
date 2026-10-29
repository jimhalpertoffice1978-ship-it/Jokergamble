// Levels, VIP tiers, achievements and the daily bonus. All rewards are play tokens.
import { MIN_BET } from './config.js';

export const TIERS = [
  { id: 'bronze', name: 'Bronze', at: 0 },
  { id: 'silver', name: 'Silver', at: 5_000 },
  { id: 'gold', name: 'Gold', at: 25_000 },
  { id: 'platinum', name: 'Platinum', at: 100_000 },
  { id: 'diamond', name: 'Diamond', at: 500_000 },
];
export const tierFor = (wagered) => TIERS.reduce((t, x) => (wagered >= x.at ? x : t), TIERS[0]);
export const nextTier = (wagered) => TIERS.find((t) => t.at > wagered) || null;

export const levelOf = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1;
export const xpAt = (level) => 50 * (level - 1) ** 2;

export const ACHIEVEMENTS = [
  { id: 'first_win', name: 'First Blood', desc: 'Win your first round', reward: 100, test: (p) => p.stats.wins >= 1 },
  { id: 'streak_5', name: 'Hot Hand', desc: 'Win 5 rounds in a row', reward: 250, test: (p) => p.stats.streak >= 5 },
  { id: 'rounds_100', name: 'Regular', desc: 'Play 100 rounds', reward: 500, test: (p) => p.stats.rounds >= 100 },
  { id: 'natural', name: 'Natural', desc: 'Get a Blackjack', reward: 150, test: (p, c) => c.tags.includes('blackjack') },
  { id: 'double_down', name: 'Nerves of Steel', desc: 'Win a doubled hand', reward: 150, test: (p, c) => c.tags.includes('double_win') },
  { id: 'lucky_number', name: 'Lucky Number', desc: 'Hit a straight-up number', reward: 300, test: (p, c) => c.tags.includes('straight_hit') },
  { id: 'high_roller', name: 'High Roller', desc: 'Wager 1,000+ in one round', reward: 300, test: (p, c) => c.wagered >= 1000 },
  { id: 'jackpot', name: 'Jackpot Night', desc: 'Win 2,500+ in one round', reward: 500, test: (p, c) => c.net >= 2500 },
];

export const blankStats = () => ({
  rounds: 0, wins: 0, losses: 0, pushes: 0, wagered: 0, won: 0, biggestWin: 0, streak: 0, bestStreak: 0, rebuys: 0, byGame: {},
});

/** Update stats, XP, levels and achievements after a finished round. Returns client events. */
export function recordRound(p, gameId, settled, now) {
  const net = settled.returned - settled.wagered;
  const st = p.stats;
  st.rounds++;
  st.wagered += settled.wagered;
  st.won += settled.returned;
  if (net > 0) {
    st.wins++;
    st.streak++;
    st.bestStreak = Math.max(st.bestStreak, st.streak);
    st.biggestWin = Math.max(st.biggestWin, net);
  } else if (net < 0) {
    st.losses++;
    st.streak = 0;
  } else st.pushes++;
  const g = (st.byGame[gameId] ||= { rounds: 0, net: 0 });
  g.rounds++;
  g.net += net;

  const events = [];
  const before = levelOf(p.xp);
  p.xp += Math.max(1, Math.ceil(settled.wagered / 10));
  for (let l = before + 1; l <= levelOf(p.xp); l++) {
    const reward = 50 * l;
    p.balance += reward;
    events.push({ type: 'levelup', level: l, reward });
  }
  const ctx = { ...settled, net };
  for (const a of ACHIEVEMENTS) {
    if (!p.ach[a.id] && a.test(p, ctx)) {
      p.ach[a.id] = now;
      p.balance += a.reward;
      events.push({ type: 'ach', id: a.id, name: a.name, reward: a.reward });
    }
  }
  return events;
}

const DAILY_COOLDOWN = 20 * 3600e3;
const STREAK_WINDOW = 48 * 3600e3;

export function dailyInfo(p, now) {
  const d = p.daily;
  const streakNext = d.last && now - d.last <= STREAK_WINDOW ? d.streak + 1 : 1;
  return { available: now >= d.next, next: d.next, streak: d.streak, streakNext, amount: 200 + 50 * Math.min(streakNext - 1, 9) };
}

export function claimDaily(p, now) {
  const info = dailyInfo(p, now);
  if (!info.available) return { ok: false, error: 'Your bonus is not ready yet.' };
  p.balance += info.amount;
  p.daily = { last: now, next: now + DAILY_COOLDOWN, streak: info.streakNext };
  return { ok: true, amount: info.amount, streak: info.streakNext };
}

/** opts: { dailyBonus, freshStart } host switches, { hasStake } tokens currently on a table. */
export function publicProfile(p, now, opts = {}) {
  const level = levelOf(p.xp);
  const tier = tierFor(p.stats.wagered);
  const nt = nextTier(p.stats.wagered);
  const daily = dailyInfo(p, now);
  return {
    id: p.id,
    name: p.name,
    balance: p.balance,
    level,
    xp: p.xp,
    xpFloor: xpAt(level),
    xpNext: xpAt(level + 1),
    tier: { id: tier.id, name: tier.name },
    nextTier: nt ? { name: nt.name, at: nt.at } : null,
    stats: p.stats,
    ach: Object.keys(p.ach),
    daily: { ...daily, enabled: opts.dailyBonus !== false, available: opts.dailyBonus !== false && daily.available },
    canRebuy: opts.freshStart !== false && p.balance < MIN_BET && !opts.hasStake,
  };
}
