// A card is a two-char string: rank + suit, e.g. "As", "Td", "2c".
// Ranks: 2 3 4 5 6 7 8 9 T J Q K A   Suits: s h d c

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['s', 'h', 'd', 'c'];

// Numeric value of a rank, 2..14 (Ace high). Ace-low is handled in the evaluator.
export const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));

export function freshDeck() {
  const deck = [];
  for (const r of RANKS) {
    for (const s of SUITS) deck.push(r + s);
  }
  return deck;
}

// Fisher-Yates shuffle. Accepts an injectable RNG for deterministic tests.
export function shuffle(deck, rng = Math.random) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
