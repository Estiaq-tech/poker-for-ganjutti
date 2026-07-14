'use strict';

const $ = (sel) => document.querySelector(sel);
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED = new Set(['h', 'd']);

let ws = null;
let me = { id: null, code: null };
let last = null; // last public state
let turnDeadline = null;
let timerRAF = null;

// ---- connection --------------------------------------------------------

function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => onOpen && onOpen();
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    setStatus('Disconnected — reconnecting…');
    setTimeout(() => reconnect(), 1500);
  };
}

function sendMsg(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function reconnect() {
  const saved = loadSession();
  if (!saved) return;
  connect(() => sendMsg({ type: 'joinTable', code: saved.code, name: saved.name, playerId: saved.id }));
}

function saveSession(data) { localStorage.setItem('takapoker', JSON.stringify(data)); }
function loadSession() { try { return JSON.parse(localStorage.getItem('takapoker')); } catch { return null; } }

// ---- message handling --------------------------------------------------

function handle(msg) {
  if (msg.type === 'joined') {
    me.id = msg.playerId; me.code = msg.code;
    const name = $('#nick').value || (loadSession() && loadSession().name) || 'Player';
    saveSession({ id: me.id, code: me.code, name });
    showGame();
  } else if (msg.type === 'state') {
    render(msg);
  } else if (msg.type === 'error') {
    if (!last) $('#lobbyError').textContent = msg.message;
    else setStatus(msg.message);
  }
}

// ---- lobby -------------------------------------------------------------

$('#createBtn').onclick = () => {
  const name = $('#nick').value.trim();
  if (!name) return ($('#lobbyError').textContent = 'Enter a nickname first');
  connect(() => sendMsg({
    type: 'createTable', name,
    startingStack: +$('#startStack').value,
    smallBlind: +$('#sb').value,
    bigBlind: +$('#bb').value,
  }));
};

$('#joinBtn').onclick = () => {
  const name = $('#nick').value.trim();
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!name) return ($('#lobbyError').textContent = 'Enter a nickname first');
  if (!code) return ($('#lobbyError').textContent = 'Enter a table code');
  connect(() => sendMsg({ type: 'joinTable', code, name }));
};

// Prefill code from an invite link (?t=CODE).
const urlCode = new URLSearchParams(location.search).get('t');
if (urlCode) $('#joinCode').value = urlCode.toUpperCase();

function showGame() {
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#tableCode').textContent = me.code;
}

$('#copyLink').onclick = () => {
  const url = `${location.origin}/?t=${me.code}`;
  navigator.clipboard.writeText(url).then(() => {
    $('#copyLink').textContent = 'Copied!';
    setTimeout(() => ($('#copyLink').textContent = 'Copy invite link'), 1500);
  });
};

$('#dealBtn').onclick = () => sendMsg({ type: 'startHand' });
$('#resetBtn').onclick = () => { if (confirm('Reset everyone to the starting stack?')) sendMsg({ type: 'newSession' }); };
$('#leaveBtn').onclick = () => {
  sendMsg({ type: 'leave' });
  localStorage.removeItem('takapoker');
  location.href = location.origin;
};

// ---- rendering ---------------------------------------------------------

function render(msg) {
  last = msg.public;
  const pub = msg.public;
  const priv = msg.private;
  const hand = pub.hand;

  $('#blindInfo').textContent = `Blinds ৳${pub.smallBlind}/৳${pub.bigBlind} · Stack ৳${pub.startingStack}`;
  $('#handInfo').textContent = hand ? `Hand #${hand.number} · ${cap(hand.street)}` : 'Waiting to start';

  $('#dealBtn').classList.toggle('hidden', !(msg.isHost && (!hand || hand.complete)));
  $('#resetBtn').classList.toggle('hidden', !msg.isHost);

  renderSeats(pub, priv);
  renderBoard(hand);
  $('#pot').textContent = hand ? `Pot: ৳${hand.pot}` : '';

  renderStatus(pub, msg.isHost);
  renderActions(pub, priv);
  renderLog(hand);
}

// Arrange seats around the ellipse with the local player pinned to the bottom.
function renderSeats(pub, priv) {
  const seatsEl = $('#seats');
  seatsEl.innerHTML = '';
  const players = pub.players;
  const total = Math.max(pub.players.length, 2);

  const mySeatIndex = players.findIndex((p) => p.id === me.id);
  const ordered = players.slice();
  // Rotate so I'm first (bottom-center), others clockwise around me.
  const rot = mySeatIndex === -1 ? 0 : mySeatIndex;
  const view = ordered.slice(rot).concat(ordered.slice(0, rot));

  const n = view.length;
  view.forEach((p, i) => {
    // angle: index 0 at bottom (90deg), going clockwise.
    const angle = Math.PI / 2 + (i / n) * 2 * Math.PI;
    const x = 50 + 46 * Math.cos(angle);
    const y = 52 + 42 * Math.sin(angle);
    const el = document.createElement('div');
    el.className = 'seat';
    el.style.left = x + '%';
    el.style.top = y + '%';

    const isTurn = pub.hand && pub.hand.turnSeat === p.seat && !pub.hand.complete;
    if (isTurn) el.classList.add('active');
    if (p.folded) el.classList.add('folded');

    const isMe = p.id === me.id;
    const result = pub.hand && pub.hand.results && pub.hand.results.find((r) => r.playerId === p.id);

    // Hole cards: mine are shown; others are backs, or revealed at showdown.
    let holeHTML = '<div class="hole">';
    if (isMe && priv && priv.you && priv.you.hole.length) {
      holeHTML += priv.you.hole.map((c) => cardHTML(c, true)).join('');
    } else if (result && result.hole) {
      holeHTML += result.hole.map((c) => cardHTML(c, true)).join(''); // showdown reveal
    } else if (p.hasCards) {
      holeHTML += cardHTML(null) + cardHTML(null);
    }
    holeHTML += '</div>';

    const badges = [];
    if (p.seat === pub.buttonSeat) badges.push('<span class="badge btn">D</span>');
    if (isMe) badges.push('<span class="badge you">YOU</span>');
    if (p.allIn) badges.push('<span class="badge allin">ALL-IN</span>');
    if (result && result.won > 0) badges.push(`<span class="badge won">+৳${result.won}</span>`);

    el.innerHTML = `
      ${holeHTML}
      <div class="plate">
        <div class="name">${esc(p.name)}${p.sittingOut ? ' 💤' : ''}</div>
        <div class="stack">৳${p.stack}</div>
        <div class="badges">${badges.join('')}</div>
        <div class="bet">${p.bet > 0 ? '৳' + p.bet : ''}</div>
        ${isTurn ? '<div class="timer-bar" id="timerBar"></div>' : ''}
      </div>`;
    seatsEl.appendChild(el);
  });

  startTurnTimer(pub);
}

function renderBoard(hand) {
  const el = $('#board');
  el.innerHTML = '';
  if (!hand) return;
  for (const c of hand.board) el.insertAdjacentHTML('beforeend', cardHTML(c, true));
}

function renderStatus(pub, isHost) {
  const hand = pub.hand;
  const el = $('#statusMsg');
  if (!hand) {
    const n = pub.players.length;
    el.textContent = n < 2
      ? 'Share the invite link — need at least 2 players.'
      : (isHost ? 'Ready. Press “Deal next hand”.' : 'Waiting for the host to deal…');
    return;
  }
  if (hand.complete) {
    const winners = (hand.results || []).filter((r) => r.won > 0);
    el.textContent = winners.length
      ? winners.map((w) => `${w.name} wins ৳${w.won}${w.hand ? ' (' + w.hand + ')' : ''}`).join(' · ') + ' — next hand shortly…'
      : 'Hand complete.';
    return;
  }
  el.textContent = '';
}

function renderActions(pub, priv) {
  const box = $('#actions');
  const wait = $('#waitMsg');
  const hand = pub.hand;
  const myTurn = hand && !hand.complete && priv && priv.you && priv.you.legalActions
    && pub.players[findIdx(pub, me.id)] && pub.hand.turnSeat === pub.players[findIdx(pub, me.id)].seat;

  if (!myTurn) {
    box.classList.add('hidden');
    if (hand && !hand.complete) {
      const cur = pub.players.find((p) => p.seat === hand.turnSeat);
      wait.textContent = cur ? `Waiting on ${cur.name}…` : '';
    } else wait.textContent = '';
    return;
  }

  const la = priv.you.legalActions;
  wait.textContent = '';
  box.classList.remove('hidden');

  const foldBtn = box.querySelector('[data-act="fold"]');
  const checkBtn = box.querySelector('[data-act="check"]');
  const callBtn = box.querySelector('[data-act="call"]');
  const raiseBtn = box.querySelector('[data-act="raise"]');
  const allInBtn = $('#allInBtn');
  const slider = $('#raiseSlider');
  const raiseGroup = box.querySelector('.raise-group');

  foldBtn.disabled = !la.fold;
  checkBtn.style.display = la.check ? '' : 'none';
  callBtn.style.display = la.call ? '' : 'none';
  if (la.call) callBtn.textContent = `Call ৳${la.call.amount}`;

  if (la.raise) {
    raiseGroup.style.display = '';
    slider.min = la.raise.min;
    slider.max = la.raise.max;
    slider.step = Math.max(1, pub.bigBlind);
    if (+slider.value < la.raise.min || +slider.value > la.raise.max) slider.value = la.raise.min;
    const upd = () => ($('#raiseAmt').textContent = '৳' + slider.value);
    slider.oninput = upd; upd();
    raiseBtn.onclick = () => act({ type: 'raise', amount: +slider.value });
    allInBtn.style.display = la.raise.max > la.raise.min ? '' : 'none';
    allInBtn.onclick = () => act({ type: 'raise', amount: la.raise.max });
  } else {
    raiseGroup.style.display = 'none';
  }

  foldBtn.onclick = () => act({ type: 'fold' });
  checkBtn.onclick = () => act({ type: 'check' });
  callBtn.onclick = () => act({ type: 'call' });
}

function act(action) {
  sendMsg({ type: 'action', action });
  $('#actions').classList.add('hidden'); // optimistic; server reply re-renders
}

function renderLog(hand) {
  const el = $('#log');
  if (!hand || !hand.log) { el.innerHTML = ''; return; }
  el.innerHTML = hand.log.slice(-8).map((l) => `<div>${esc(l)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}

// ---- turn timer (visual) ----------------------------------------------

function startTurnTimer(pub) {
  cancelAnimationFrame(timerRAF);
  const hand = pub.hand;
  if (!hand || hand.complete || hand.turnSeat === -1) { turnDeadline = null; return; }
  const TURN_MS = 45000;
  turnDeadline = Date.now() + TURN_MS;
  const bar = document.getElementById('timerBar');
  if (!bar) return;
  const tick = () => {
    const remain = Math.max(0, turnDeadline - Date.now());
    bar.style.width = (remain / TURN_MS) * 100 + '%';
    if (remain > 0) timerRAF = requestAnimationFrame(tick);
  };
  tick();
}

// ---- helpers -----------------------------------------------------------

function cardHTML(card, faceUp) {
  if (!card || !faceUp) return '<div class="card back small">🂠</div>';
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  const red = RED.has(suit) ? ' red' : '';
  return `<div class="card small${red}"><span>${rank}</span><span class="suit">${SUIT[suit]}</span></div>`;
}

function findIdx(pub, id) { return pub.players.findIndex((p) => p.id === id); }
function setStatus(t) { const e = $('#statusMsg'); if (e) e.textContent = t; }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Auto-reconnect on load if we have a saved session.
if (loadSession()) reconnect();
