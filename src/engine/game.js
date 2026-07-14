import { freshDeck, shuffle } from './deck.js';
import { evaluateBest, compareScores } from './handEvaluator.js';

// A Table holds persistent seats (players keep their stacks between hands within a
// session) and runs one hand at a time. The server calls into it; all game rules
// and secret state (hole cards, deck) live here so clients can't cheat.
//
// Chip amounts are plain integers of taka (৳). Play money only.

export const STREETS = ['preflop', 'flop', 'turn', 'river'];

export class Table {
  constructor({ id, startingStack = 1000, smallBlind = 5, bigBlind = 10, maxSeats = 9, rng = Math.random } = {}) {
    this.id = id;
    this.startingStack = startingStack;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.maxSeats = maxSeats;
    this.rng = rng;

    this.seats = new Array(maxSeats).fill(null); // seat index -> player | null
    this.buttonSeat = -1;
    this.hand = null; // current hand state, or null between hands
    this.handNumber = 0;
  }

  // ---- seat management -------------------------------------------------

  players() {
    return this.seats.filter(Boolean);
  }

  seatOf(playerId) {
    return this.seats.findIndex((p) => p && p.id === playerId);
  }

  addPlayer({ id, name }, seat = null) {
    if (this.seatOf(id) !== -1) return this.seatOf(id);
    let s = seat;
    if (s == null || this.seats[s]) s = this.seats.findIndex((x) => x === null);
    if (s === -1) throw new Error('table full');
    this.seats[s] = {
      id,
      name,
      seat: s,
      stack: this.startingStack,
      // per-hand fields, reset at hand start:
      hole: [],
      folded: false,
      allIn: false,
      bet: 0, // contribution in the current betting round
      committed: 0, // total contribution this hand (for side pots)
      hasActed: false,
      inHand: false,
      sittingOut: false,
    };
    return s;
  }

  removePlayer(playerId) {
    const s = this.seatOf(playerId);
    if (s === -1) return;
    // If they're in a live hand, fold them first so the pot math stays sound.
    if (this.hand && this.seats[s].inHand && !this.seats[s].folded) {
      try { this.act(playerId, { type: 'fold' }); } catch { /* hand may be over */ }
    }
    this.seats[s] = null;
  }

  // Reset every player's stack to the starting amount (host "new session" button).
  resetStacks() {
    for (const p of this.players()) p.stack = this.startingStack;
    this.hand = null;
  }

  eligibleForHand() {
    // Seated players with chips who aren't sitting out.
    return this.players().filter((p) => p.stack > 0 && !p.sittingOut);
  }

  // ---- hand lifecycle --------------------------------------------------

  startHand() {
    const contenders = this.eligibleForHand();
    if (contenders.length < 2) throw new Error('need at least 2 players with chips');

    for (const p of this.players()) {
      p.hole = [];
      p.folded = false;
      p.allIn = false;
      p.bet = 0;
      p.committed = 0;
      p.hasActed = false;
      p.inHand = p.stack > 0 && !p.sittingOut;
    }

    // Advance button to the next occupied, eligible seat.
    this.buttonSeat = this._nextOccupiedSeat(this.buttonSeat, (p) => p.inHand);

    const order = this._seatOrderFrom(this.buttonSeat); // clockwise starting AT button
    const inHand = order.filter((p) => p.inHand);
    const hepsUp = inHand.length === 2;

    const deck = shuffle(freshDeck(), this.rng);

    this.hand = {
      number: ++this.handNumber,
      deck,
      board: [],
      street: 'preflop',
      pot: 0,
      betToMatch: 0,
      minRaise: this.bigBlind,
      lastAggressor: null,
      turnSeat: -1,
      log: [],
      pots: null, // filled at showdown
      results: null,
      complete: false,
    };

    // Post blinds. Heads-up: button is the small blind and acts first preflop.
    let sbPlayer, bbPlayer;
    if (hepsUp) {
      sbPlayer = this.seats[this.buttonSeat];
      bbPlayer = inHand.find((p) => p !== sbPlayer);
    } else {
      sbPlayer = inHand[1 % inHand.length]; // one seat left of button
      bbPlayer = inHand[2 % inHand.length];
    }
    this._postBlind(sbPlayer, this.smallBlind);
    this._postBlind(bbPlayer, this.bigBlind);
    this.hand.betToMatch = this.bigBlind;
    this.hand.minRaise = this.bigBlind;
    this.hand.lastAggressor = bbPlayer.seat; // BB gets the option to raise

    // Deal two hole cards to each in-hand player, starting left of button.
    for (let round = 0; round < 2; round++) {
      for (const p of inHand) p.hole.push(this.hand.deck.pop());
    }

    // First to act preflop: left of BB (or the button/SB in heads-up).
    const firstToAct = hepsUp ? sbPlayer.seat : this._seatAfter(bbPlayer.seat, (p) => p.inHand && !p.allIn);
    this.hand.turnSeat = firstToAct;

    this._log(`Hand #${this.hand.number}: blinds ৳${this.smallBlind}/৳${this.bigBlind}`);
    this._maybeSkipToShowdown();
    return this.publicState();
  }

  _postBlind(player, amount) {
    const post = Math.min(amount, player.stack);
    player.stack -= post;
    player.bet += post;
    player.committed += post;
    this.hand ? (this.hand.pot += post) : null;
    if (player.stack === 0) player.allIn = true;
  }

  // ---- taking actions --------------------------------------------------

  currentPlayer() {
    if (!this.hand || this.hand.complete) return null;
    return this.hand.turnSeat === -1 ? null : this.seats[this.hand.turnSeat];
  }

  // What can the player to act legally do right now?
  legalActions(playerId) {
    const p = this.seatOf(playerId) === -1 ? null : this.seats[this.seatOf(playerId)];
    const cur = this.currentPlayer();
    if (!p || !cur || cur.id !== playerId) return null;

    const toCall = this.hand.betToMatch - p.bet;
    const actions = { fold: true };

    if (toCall <= 0) {
      actions.check = true;
    } else {
      actions.call = { amount: Math.min(toCall, p.stack) }; // may be a partial (all-in) call
    }

    // Raising / betting.
    const maxTotal = p.bet + p.stack; // the most this player can have in this round (all-in)
    const minTotal = this.hand.betToMatch + this.hand.minRaise;
    if (p.stack > toCall) {
      actions.raise = {
        min: Math.min(minTotal, maxTotal), // if a full raise isn't affordable, min == all-in
        max: maxTotal,
        toCall: Math.max(0, toCall),
      };
    }
    return actions;
  }

  // action: { type: 'fold' | 'check' | 'call' | 'raise', amount? }
  // For 'raise', amount is the TOTAL the player wants in the pot this round ("raise to").
  act(playerId, action) {
    const cur = this.currentPlayer();
    if (!cur || cur.id !== playerId) throw new Error('not your turn');
    const p = cur;
    const h = this.hand;

    switch (action.type) {
      case 'fold': {
        p.folded = true;
        p.hasActed = true;
        this._log(`${p.name} folds`);
        break;
      }
      case 'check': {
        if (h.betToMatch - p.bet > 0) throw new Error('cannot check facing a bet');
        p.hasActed = true;
        this._log(`${p.name} checks`);
        break;
      }
      case 'call': {
        const toCall = h.betToMatch - p.bet;
        if (toCall <= 0) throw new Error('nothing to call');
        this._commit(p, Math.min(toCall, p.stack));
        p.hasActed = true;
        this._log(`${p.name} calls ৳${Math.min(toCall, p.stack)}`);
        break;
      }
      case 'raise': {
        const total = Math.floor(action.amount);
        const maxTotal = p.bet + p.stack;
        if (total > maxTotal) throw new Error('not enough chips');
        const isAllIn = total === maxTotal;
        const minTotal = h.betToMatch + h.minRaise;
        if (total < minTotal && !isAllIn) throw new Error(`raise must be at least ৳${minTotal}`);
        if (total <= h.betToMatch) throw new Error('raise must exceed current bet');

        const raiseSize = total - h.betToMatch;
        this._commit(p, total - p.bet);
        // A full-size raise reopens betting and sets the new minimum raise.
        if (raiseSize >= h.minRaise) {
          h.minRaise = raiseSize;
          h.lastAggressor = p.seat;
          // Everyone else must respond again.
          for (const q of this.players()) {
            if (q !== p && q.inHand && !q.folded && !q.allIn) q.hasActed = false;
          }
        }
        h.betToMatch = total;
        p.hasActed = true;
        this._log(`${p.name} raises to ৳${total}${isAllIn ? ' (all-in)' : ''}`);
        break;
      }
      default:
        throw new Error(`unknown action ${action.type}`);
    }

    this._advanceTurn();
    return this.publicState();
  }

  _commit(p, amount) {
    const amt = Math.min(amount, p.stack);
    p.stack -= amt;
    p.bet += amt;
    p.committed += amt;
    this.hand.pot += amt;
    if (p.stack === 0) p.allIn = true;
  }

  _advanceTurn() {
    const h = this.hand;
    const contenders = this.players().filter((p) => p.inHand && !p.folded);

    // Everyone folded but one -> that player wins immediately.
    if (contenders.length === 1) {
      this._awardUncontested(contenders[0]);
      return;
    }

    // Is the betting round settled? A player is settled if folded, all-in, or
    // (has acted AND matched the current bet).
    const needsAction = this.players().filter(
      (p) => p.inHand && !p.folded && !p.allIn && !(p.hasActed && p.bet === h.betToMatch),
    );

    if (needsAction.length === 0) {
      this._endBettingRound();
      return;
    }

    // Move the turn to the next player who still needs to act.
    h.turnSeat = this._seatAfter(h.turnSeat, (p) => p.inHand && !p.folded && !p.allIn && !(p.hasActed && p.bet === h.betToMatch));
  }

  _endBettingRound() {
    const h = this.hand;
    // Collect bets into the pot (already tracked in .committed); reset round bets.
    for (const p of this.players()) {
      p.bet = 0;
      p.hasActed = false;
    }
    h.betToMatch = 0;
    h.minRaise = this.bigBlind;

    if (h.street === 'river') {
      this._showdown();
      return;
    }
    this._dealNextStreet();

    // First to act after the flop onward: first in-hand player left of the button.
    const next = this._seatAfter(this.buttonSeat, (p) => p.inHand && !p.folded && !p.allIn);
    h.turnSeat = next;
    this._maybeSkipToShowdown();
  }

  _dealNextStreet() {
    const h = this.hand;
    const idx = STREETS.indexOf(h.street);
    h.street = STREETS[idx + 1];
    this.hand.deck.pop(); // burn
    if (h.street === 'flop') {
      h.board.push(this.hand.deck.pop(), this.hand.deck.pop(), this.hand.deck.pop());
    } else {
      h.board.push(this.hand.deck.pop());
    }
    this._log(`${h.street}: ${h.board.join(' ')}`);
  }

  // If no further betting is possible (0 or 1 players can still act), run out the
  // board and go to showdown.
  _maybeSkipToShowdown() {
    const h = this.hand;
    if (h.complete) return;
    const canAct = this.players().filter((p) => p.inHand && !p.folded && !p.allIn);
    const contenders = this.players().filter((p) => p.inHand && !p.folded);
    if (contenders.length < 2) return; // uncontested handled elsewhere
    if (canAct.length <= 1) {
      // Nobody left to bet: deal remaining streets and show down.
      // But if exactly one can act and still owes chips, they get their turn first.
      if (canAct.length === 1) {
        const p = canAct[0];
        if (h.betToMatch - p.bet > 0) return; // they still have a decision to call/fold
      }
      while (h.street !== 'river') {
        for (const q of this.players()) { q.bet = 0; q.hasActed = false; }
        h.betToMatch = 0;
        this._dealNextStreet();
      }
      this._showdown();
    }
  }

  // ---- resolution ------------------------------------------------------

  _awardUncontested(winner) {
    const h = this.hand;
    winner.stack += h.pot;
    h.results = [{ playerId: winner.id, name: winner.name, won: h.pot, hand: null, cards: null }];
    this._log(`${winner.name} wins ৳${h.pot} (all others folded)`);
    h.pot = 0;
    h.complete = true;
    h.turnSeat = -1;
  }

  _showdown() {
    const h = this.hand;
    h.street = 'river';
    const contenders = this.players().filter((p) => p.inHand && !p.folded);

    // Evaluate each contender's best 5 of 7.
    const evals = new Map();
    for (const p of contenders) {
      evals.set(p.id, evaluateBest([...p.hole, ...h.board]));
    }

    const pots = this._buildSidePots();
    const results = new Map(); // playerId -> won amount

    for (const pot of pots) {
      const eligible = pot.eligible.filter((id) => contenders.some((p) => p.id === id));
      if (eligible.length === 0) continue;
      // Find best score among eligible.
      let best = null;
      for (const id of eligible) {
        const s = evals.get(id).score;
        if (!best || compareScores(s, best) > 0) best = s;
      }
      const winners = eligible.filter((id) => compareScores(evals.get(id).score, best) === 0);
      // Split, distributing odd chips to the earliest seat left of the button.
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      const ordered = this._seatOrderFrom(this.buttonSeat).filter((p) => winners.includes(p.id));
      for (const p of ordered) {
        let win = share;
        if (remainder > 0) { win += 1; remainder -= 1; }
        results.set(p.id, (results.get(p.id) || 0) + win);
      }
    }

    for (const [id, won] of results) {
      const p = this.seats[this.seatOf(id)];
      p.stack += won;
    }

    h.pots = pots.map((pt) => ({ amount: pt.amount, eligible: pt.eligible }));
    h.results = contenders.map((p) => ({
      playerId: p.id,
      name: p.name,
      won: results.get(p.id) || 0,
      hand: evals.get(p.id).name,
      cards: evals.get(p.id).cards,
      hole: p.hole,
    }));
    for (const r of h.results) {
      if (r.won > 0) this._log(`${r.name} wins ৳${r.won} with ${r.hand}`);
    }
    h.pot = 0;
    h.complete = true;
    h.turnSeat = -1;
  }

  // Build main + side pots from each player's total committed chips this hand.
  _buildSidePots() {
    const contributors = this.players().filter((p) => p.committed > 0);
    const contrib = new Map(contributors.map((p) => [p.id, p.committed]));
    const pots = [];

    while ([...contrib.values()].some((v) => v > 0)) {
      const positive = [...contrib.entries()].filter(([, v]) => v > 0);
      const level = Math.min(...positive.map(([, v]) => v));
      const amount = level * positive.length;
      // Eligible to win this layer: everyone who contributed at this level and is not folded.
      const eligible = positive
        .map(([id]) => id)
        .filter((id) => {
          const p = this.seats[this.seatOf(id)];
          return p && !p.folded;
        });
      pots.push({ amount, eligible });
      for (const [id, v] of positive) contrib.set(id, v - level);
    }

    // Merge consecutive pots with identical eligibility (cosmetic, keeps counts sane).
    const merged = [];
    for (const pot of pots) {
      const last = merged[merged.length - 1];
      if (last && sameSet(last.eligible, pot.eligible)) last.amount += pot.amount;
      else merged.push({ ...pot });
    }
    return merged;
  }

  // ---- seat/turn helpers ----------------------------------------------

  _seatOrderFrom(startSeat) {
    // Returns players in clockwise order beginning at startSeat (inclusive if occupied).
    const out = [];
    for (let i = 0; i < this.maxSeats; i++) {
      const s = (startSeat + i) % this.maxSeats;
      if (this.seats[s]) out.push(this.seats[s]);
    }
    return out;
  }

  _nextOccupiedSeat(fromSeat, pred = () => true) {
    for (let i = 1; i <= this.maxSeats; i++) {
      const s = (fromSeat + i) % this.maxSeats;
      if (this.seats[s] && pred(this.seats[s])) return s;
    }
    return fromSeat;
  }

  _seatAfter(fromSeat, pred) {
    for (let i = 1; i <= this.maxSeats; i++) {
      const s = (fromSeat + i) % this.maxSeats;
      if (this.seats[s] && pred(this.seats[s])) return s;
    }
    return -1;
  }

  _log(msg) {
    if (this.hand) this.hand.log.push(msg);
  }

  // ---- views -----------------------------------------------------------

  // Public state safe to broadcast to everyone (no hole cards, no deck).
  publicState() {
    const h = this.hand;
    return {
      tableId: this.id,
      startingStack: this.startingStack,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      buttonSeat: this.buttonSeat,
      players: this.players().map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        stack: p.stack,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        inHand: p.inHand,
        sittingOut: p.sittingOut,
        hasCards: !!(h && p.inHand && p.hole.length > 0 && !p.folded),
      })),
      hand: h
        ? {
            number: h.number,
            street: h.street,
            board: h.board,
            pot: h.pot, // running total; already includes current-round bets
            betToMatch: h.betToMatch,
            minRaise: h.minRaise,
            turnSeat: h.turnSeat,
            complete: h.complete,
            results: h.complete ? h.results : null,
            log: h.log,
          }
        : null,
    };
  }

  // Private view for one player: their hole cards plus whose turn it is.
  privateState(playerId) {
    const s = this.seatOf(playerId);
    if (s === -1) return null;
    const p = this.seats[s];
    return {
      you: {
        id: p.id,
        seat: p.seat,
        hole: this.hand && p.inHand ? p.hole : [],
        stack: p.stack,
        legalActions: this.legalActions(playerId),
      },
    };
  }
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}
