import { RANK_VALUE } from './deck.js';

// Hand categories, higher is better.
export const CATEGORY = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_KIND: 7,
  STRAIGHT_FLUSH: 8,
};

export const CATEGORY_NAME = [
  'High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

// Compare two score arrays lexicographically. >0 if a beats b, <0 if b beats a, 0 tie.
export function compareScores(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Given the ranks present (with duplicates), detect the top straight high card, or 0 if none.
// Handles the wheel: A-2-3-4-5 (Ace plays low, high card = 5).
function straightHigh(valueSet) {
  // valueSet: Set of distinct rank values 2..14
  const has = (v) => valueSet.has(v);
  // Ace-low: treat Ace (14) as 1 for the wheel.
  for (let high = 14; high >= 5; high--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      let v = high - k;
      if (v === 1) v = 14; // (not reached; loop stops at high=5 -> low=1 handled below)
      if (!has(v)) { ok = false; break; }
    }
    if (ok) return high;
  }
  // Wheel: A,2,3,4,5
  if (has(14) && has(2) && has(3) && has(4) && has(5)) return 5;
  return 0;
}

// Evaluate exactly 5 cards -> score array [category, tiebreakers...].
export function evaluate5(cards) {
  const values = cards.map((c) => RANK_VALUE[c[0]]).sort((a, b) => b - a);
  const suits = cards.map((c) => c[1]);

  const counts = new Map(); // value -> count
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);

  // Sort groups by (count desc, value desc): decisive for pairs/trips/quads tiebreaks.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const isFlush = suits.every((s) => s === suits[0]);
  const distinct = new Set(values);
  const sHigh = straightHigh(distinct);
  const isStraight = sHigh !== 0 && distinct.size === 5;

  if (isStraight && isFlush) return [CATEGORY.STRAIGHT_FLUSH, sHigh];

  if (groups[0][1] === 4) {
    const quad = groups[0][0];
    const kicker = groups[1][0];
    return [CATEGORY.FOUR_KIND, quad, kicker];
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return [CATEGORY.FULL_HOUSE, groups[0][0], groups[1][0]];
  }
  if (isFlush) return [CATEGORY.FLUSH, ...values];
  if (isStraight) return [CATEGORY.STRAIGHT, sHigh];
  if (groups[0][1] === 3) {
    const trip = groups[0][0];
    const kickers = groups.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return [CATEGORY.THREE_KIND, trip, ...kickers];
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const highPair = Math.max(groups[0][0], groups[1][0]);
    const lowPair = Math.min(groups[0][0], groups[1][0]);
    const kicker = groups[2][0];
    return [CATEGORY.TWO_PAIR, highPair, lowPair, kicker];
  }
  if (groups[0][1] === 2) {
    const pair = groups[0][0];
    const kickers = groups.slice(1).map((g) => g[0]).sort((a, b) => b - a);
    return [CATEGORY.ONE_PAIR, pair, ...kickers];
  }
  return [CATEGORY.HIGH_CARD, ...values];
}

function* combinations(arr, k) {
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// Best 5-card hand out of 5, 6, or 7 cards.
// Returns { score, cards, name }.
export function evaluateBest(cards) {
  if (cards.length < 5) throw new Error('need at least 5 cards');
  let best = null;
  let bestCards = null;
  for (const combo of combinations(cards, 5)) {
    const score = evaluate5(combo);
    if (!best || compareScores(score, best) > 0) {
      best = score;
      bestCards = combo;
    }
  }
  return { score: best, cards: bestCards, name: CATEGORY_NAME[best[0]] };
}
