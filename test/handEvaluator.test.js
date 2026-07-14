import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate5, evaluateBest, compareScores, CATEGORY } from '../src/engine/handEvaluator.js';

function cat(cards) {
  return evaluate5(cards)[0];
}

test('categories are detected', () => {
  assert.equal(cat(['As', 'Ks', 'Qs', 'Js', 'Ts']), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(cat(['9h', '9d', '9s', '9c', 'Kd']), CATEGORY.FOUR_KIND);
  assert.equal(cat(['9h', '9d', '9s', 'Kc', 'Kd']), CATEGORY.FULL_HOUSE);
  assert.equal(cat(['2h', '7h', '9h', 'Jh', 'Kh']), CATEGORY.FLUSH);
  assert.equal(cat(['5h', '6d', '7s', '8c', '9d']), CATEGORY.STRAIGHT);
  assert.equal(cat(['9h', '9d', '9s', 'Qc', 'Kd']), CATEGORY.THREE_KIND);
  assert.equal(cat(['9h', '9d', 'Ks', 'Kc', '2d']), CATEGORY.TWO_PAIR);
  assert.equal(cat(['9h', '9d', 'Ks', 'Qc', '2d']), CATEGORY.ONE_PAIR);
  assert.equal(cat(['9h', '7d', 'Ks', 'Qc', '2d']), CATEGORY.HIGH_CARD);
});

test('wheel straight (A-2-3-4-5) is a five-high straight', () => {
  const s = evaluate5(['Ah', '2d', '3s', '4c', '5d']);
  assert.equal(s[0], CATEGORY.STRAIGHT);
  assert.equal(s[1], 5); // five-high, not ace-high
});

test('wheel straight flush ranks below higher straight flushes', () => {
  const wheel = evaluate5(['Ah', '2h', '3h', '4h', '5h']);
  const sixHigh = evaluate5(['2h', '3h', '4h', '5h', '6h']);
  assert.equal(wheel[0], CATEGORY.STRAIGHT_FLUSH);
  assert.ok(compareScores(sixHigh, wheel) > 0);
});

test('ace-high straight beats king-high straight', () => {
  const broadway = evaluate5(['Ah', 'Kd', 'Qs', 'Jc', 'Td']);
  const kingHigh = evaluate5(['Kh', 'Qd', 'Js', 'Tc', '9d']);
  assert.ok(compareScores(broadway, kingHigh) > 0);
});

test('kickers break ties within a category', () => {
  const aceKicker = evaluate5(['9h', '9d', 'As', '5c', '2d']);
  const kingKicker = evaluate5(['9c', '9s', 'Ks', '5h', '2c']);
  assert.ok(compareScores(aceKicker, kingKicker) > 0);
});

test('flush compared high-card down', () => {
  const a = evaluate5(['Ah', 'Qh', '9h', '5h', '3h']);
  const b = evaluate5(['Ah', 'Jh', '9h', '5h', '3h']);
  assert.ok(compareScores(a, b) > 0);
});

test('best-of-seven picks the nut hand', () => {
  // Board makes a flush available; hole completes it.
  const r = evaluateBest(['Ah', 'Kh', 'Qh', 'Jh', '2h', '3d', '4c']);
  assert.equal(r.score[0], CATEGORY.FLUSH);
});

test('full house beats flush', () => {
  const fh = evaluate5(['8h', '8d', '8s', 'Kh', 'Kd']);
  const fl = evaluate5(['Ah', 'Qh', '9h', '5h', '3h']);
  assert.ok(compareScores(fh, fl) > 0);
});

test('identical hands tie', () => {
  const a = evaluate5(['Ah', 'Kh', 'Qd', 'Jc', '9s']);
  const b = evaluate5(['As', 'Kd', 'Qh', 'Jd', '9c']);
  assert.equal(compareScores(a, b), 0);
});
