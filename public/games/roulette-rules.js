// Roulette rules shared by the server (authoritative) and the browser (hover highlights).
// European single-zero wheel. Pure functions only: no DOM, no Node APIs.

/** Pocket order around the wheel, clockwise from the zero. */
export const WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29,
  7, 28, 12, 35, 3, 26,
];
export const REDS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const RED = new Set(REDS);
export const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

/** Profit multiple on a winning bet (you also get the stake back). */
export const PAYOUT = {
  straight: 35,
  split: 17,
  street: 11,
  corner: 8,
  sixline: 5,
  column: 2,
  dozen: 2,
  red: 1,
  black: 1,
  odd: 1,
  even: 1,
  low: 1,
  high: 1,
};

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const int = Number.isInteger;
const all36 = range(1, 36);

/**
 * Numbers covered by a bet, or null when the bet is not valid.
 *   straight: sel = number 0..36          split: sel = [a, b] adjacent on the layout (0 touches 1, 2, 3)
 *   street:   sel = row 1..12             corner: sel = lowest of the four numbers (not in the 3rd column)
 *   sixline:  sel = upper row 1..11       column / dozen: sel = 1..3
 *   red, black, odd, even, low (1-18), high (19-36): no sel
 */
export function coverage(type, sel) {
  switch (type) {
    case 'straight':
      return int(sel) && sel >= 0 && sel <= 36 ? [sel] : null;
    case 'split': {
      if (!Array.isArray(sel) || sel.length !== 2 || !sel.every(int)) return null;
      const [a, b] = [...sel].sort((x, y) => x - y);
      if (a < 0 || b > 36 || a === b) return null;
      if (a === 0) return b <= 3 ? [0, b] : null;
      const sameRow = Math.ceil(a / 3) === Math.ceil(b / 3);
      return (b - a === 1 && sameRow) || b - a === 3 ? [a, b] : null;
    }
    case 'street':
      return int(sel) && sel >= 1 && sel <= 12 ? [3 * sel - 2, 3 * sel - 1, 3 * sel] : null;
    case 'corner':
      return int(sel) && sel >= 1 && sel <= 32 && sel % 3 !== 0 ? [sel, sel + 1, sel + 3, sel + 4] : null;
    case 'sixline':
      return int(sel) && sel >= 1 && sel <= 11 ? range(3 * sel - 2, 3 * sel + 3) : null;
    case 'column':
      return int(sel) && sel >= 1 && sel <= 3 ? all36.filter((n) => (n % 3 || 3) === sel) : null;
    case 'dozen':
      return int(sel) && sel >= 1 && sel <= 3 ? range(12 * (sel - 1) + 1, 12 * sel) : null;
    case 'red':
      return [...REDS];
    case 'black':
      return all36.filter((n) => !RED.has(n));
    case 'odd':
      return all36.filter((n) => n % 2 === 1);
    case 'even':
      return all36.filter((n) => n % 2 === 0);
    case 'low':
      return range(1, 18);
    case 'high':
      return range(19, 36);
    default:
      return null;
  }
}

export const betKey = (type, sel) => `${type}:${Array.isArray(sel) ? [...sel].sort((a, b) => a - b).join('-') : (sel ?? '')}`;
