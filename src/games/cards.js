// Card helpers shared by card games. A card is an integer 0..51:
//   rank = n % 13 (0 = Ace, 1 = Two ... 12 = King), suit = floor(n / 13) % 4 (S, H, D, C)
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];

export const cardObj = (n) => ({ rank: RANKS[n % 13], suit: SUITS[Math.floor(n / 13) % 4] });

/** Fisher-Yates, in place. rng(max) must return an integer in [0, max). */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function makeShoe(decks, rng) {
  const shoe = [];
  for (let d = 0; d < decks; d++) for (let i = 0; i < 52; i++) shoe.push(i);
  return shuffle(shoe, rng);
}
