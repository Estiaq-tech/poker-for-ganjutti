import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table } from '../src/engine/game.js';

// Deterministic RNG so shuffles are reproducible in tests.
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeTable(nPlayers, opts = {}) {
  const t = new Table({ id: 'T', startingStack: 1000, smallBlind: 5, bigBlind: 10, rng: seededRng(42), ...opts });
  for (let i = 0; i < nPlayers; i++) t.addPlayer({ id: `p${i}`, name: `P${i}` });
  return t;
}

test('blinds are posted and pot reflects them', () => {
  const t = makeTable(3);
  t.startHand();
  const state = t.publicState();
  assert.equal(state.hand.pot, 15); // SB 5 + BB 10
  const bets = state.players.map((p) => p.bet).sort((a, b) => a - b);
  assert.deepEqual(bets, [0, 5, 10]);
});

test('everyone folding to one player awards the pot uncontested', () => {
  const t = makeTable(3);
  t.startHand();
  // UTG (first to act) folds, then next folds -> last remaining wins blinds.
  let cur = t.currentPlayer();
  t.act(cur.id, { type: 'fold' });
  cur = t.currentPlayer();
  t.act(cur.id, { type: 'fold' });
  const s = t.publicState();
  assert.ok(s.hand.complete);
  assert.equal(s.hand.results.length, 1);
  assert.equal(s.hand.results[0].won, 15);
});

test('chips are conserved across a full hand', () => {
  const t = makeTable(4);
  const total = () => t.players().reduce((a, p) => a + p.stack, 0) + (t.hand ? t.hand.pot : 0);
  const before = total();
  t.startHand();
  // Play to showdown: everyone calls / checks through.
  let guard = 0;
  while (t.hand && !t.hand.complete && guard++ < 200) {
    const cur = t.currentPlayer();
    if (!cur) break;
    const la = t.legalActions(cur.id);
    if (la.check) t.act(cur.id, { type: 'check' });
    else t.act(cur.id, { type: 'call' });
  }
  assert.ok(t.hand.complete);
  assert.equal(total(), before); // no chips created or destroyed
  assert.equal(before, 4000);
});

test('a raise forces earlier callers to act again', () => {
  const t = makeTable(3);
  t.startHand();
  const first = t.currentPlayer();
  t.act(first.id, { type: 'call' }); // UTG calls 10
  const second = t.currentPlayer();
  t.act(second.id, { type: 'raise', amount: 30 }); // raise to 30
  // Action proceeds clockwise from the raiser; eventually it returns to the
  // earlier caller, who must now respond to the raise (call/fold, not check).
  let guard = 0;
  while (t.currentPlayer() && t.currentPlayer().id !== first.id && guard++ < 5) {
    t.act(t.currentPlayer().id, { type: 'call' });
  }
  assert.equal(t.currentPlayer().id, first.id, 'action returns to the first caller');
  const la = t.legalActions(first.id);
  assert.ok(la.call, 'must be able to call the raise');
  assert.ok(!la.check, 'cannot check facing a raise');
});

test('minimum raise is enforced', () => {
  const t = makeTable(3);
  t.startHand();
  const cur = t.currentPlayer();
  // betToMatch is 10, minRaise 10 -> min legal raise-to is 20.
  assert.throws(() => t.act(cur.id, { type: 'raise', amount: 15 }), /at least/);
});

test('side pots: short all-in caps what the shover can win', () => {
  // Three players, one is short-stacked and goes all-in; the other two build a side pot.
  const t = makeTable(3, { startingStack: 1000 });
  // Give the button player a short stack before the hand.
  t.startHand();
  const h = t.hand;
  // Force a controlled scenario by reading seats.
  // Everyone folds is not what we want; instead drive an all-in.
  // Simplest deterministic check: make one player all-in for less, others match more.
  // We'll just assert side-pot construction directly via a crafted state.
  const players = t.players();
  // Manually set committed to emulate: p0=200(all-in, not folded), p1=1000, p2=1000
  for (const p of players) { p.committed = 0; p.folded = false; }
  players[0].committed = 200;
  players[1].committed = 1000;
  players[2].committed = 1000;
  const pots = t._buildSidePots();
  // Main pot: 200*3 = 600 (all three eligible). Side pot: 800*2 = 1600 (p1,p2 only).
  assert.equal(pots.length, 2);
  assert.equal(pots[0].amount, 600);
  assert.deepEqual(pots[0].eligible.sort(), ['p0', 'p1', 'p2']);
  assert.equal(pots[1].amount, 1600);
  assert.deepEqual(pots[1].eligible.sort(), ['p1', 'p2']);
});

test('folded contributors add dead money but cannot win', () => {
  const t = makeTable(3);
  t.startHand();
  const players = t.players();
  for (const p of players) { p.committed = 0; p.folded = false; }
  players[0].committed = 100; players[0].folded = true; // folded after betting 100
  players[1].committed = 100;
  players[2].committed = 100;
  const pots = t._buildSidePots();
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 300); // folded player's 100 stays in the pot
  assert.deepEqual(pots[0].eligible.sort(), ['p1', 'p2']); // but they aren't eligible
});

test('heads-up: button posts small blind and acts first preflop', () => {
  const t = makeTable(2);
  t.startHand();
  const cur = t.currentPlayer();
  // In heads-up the button/SB acts first preflop.
  assert.equal(cur.seat, t.buttonSeat);
});

test('full all-in run-out reaches showdown with five board cards', () => {
  const t = makeTable(2, { startingStack: 100 });
  t.startHand();
  // Both shove/call all-in preflop -> board should run out fully.
  let guard = 0;
  while (t.hand && !t.hand.complete && guard++ < 50) {
    const cur = t.currentPlayer();
    if (!cur) break;
    const la = t.legalActions(cur.id);
    if (la.raise) t.act(cur.id, { type: 'raise', amount: la.raise.max });
    else if (la.call) t.act(cur.id, { type: 'call' });
    else if (la.check) t.act(cur.id, { type: 'check' });
    else t.act(cur.id, { type: 'fold' });
  }
  assert.ok(t.hand.complete);
  assert.equal(t.hand.board.length, 5);
});
