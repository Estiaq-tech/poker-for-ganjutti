// End-to-end server test: spin up two WebSocket clients, create + join a table,
// deal a hand, and play it to completion. Verifies the server wiring and that
// each client only ever sees its own hole cards.
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3000;
const URL = `ws://localhost:${PORT}`;

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, id: null, code: null, state: null, priv: null, isHost: false, queue: [] };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'joined') { c.id = msg.playerId; c.code = msg.code; }
    if (msg.type === 'state') { c.state = msg.public; c.priv = msg.private; c.isHost = msg.isHost; }
    if (msg.type === 'error') console.log(`  [${name}] server error: ${msg.message}`);
    c.queue.push(msg);
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.open = () => new Promise((res) => ws.on('open', res));
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (cond()) return true;
    await wait(20);
  }
  throw new Error('timeout waiting for condition');
}

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? '✔' : '✖'} ${label}`);
  if (!ok) failures++;
}

async function main() {
  const a = client('Alice');
  const b = client('Bob');
  await a.open();
  await b.open();

  a.send({ type: 'createTable', name: 'Alice', startingStack: 1000, smallBlind: 5, bigBlind: 10 });
  await waitFor(() => a.code);
  b.send({ type: 'joinTable', code: a.code, name: 'Bob' });
  await waitFor(() => b.id && b.state && b.state.players.length === 2);

  check('two players seated', a.state.players.length === 2);
  check('Alice is host', a.isHost === true && b.isHost === false);

  a.send({ type: 'startHand' });
  await waitFor(() => a.state.hand && a.state.hand.number === 1);

  check('blinds posted (pot 15)', a.state.hand.pot === 15);
  check('Alice sees exactly 2 hole cards', a.priv.you.hole.length === 2);
  check('Bob sees his own 2 hole cards', b.priv.you.hole.length === 2);
  check('players cannot see each others cards',
    JSON.stringify(a.priv.you.hole) !== JSON.stringify(b.priv.you.hole));
  // Neither public state should ever carry hole cards for opponents.
  const leaks = a.state.players.some((p) => 'hole' in p);
  check('public state never leaks hole cards', !leaks);

  // Play the hand: whoever is to act calls/checks until the hand completes.
  let guard = 0;
  while (guard++ < 40) {
    const s = a.state; // both share the same public state
    if (!s.hand || s.hand.complete) break;
    const turnSeat = s.hand.turnSeat;
    const actor = [a, b].find((c) => {
      const seat = s.players.find((p) => p.id === c.id);
      return seat && seat.seat === turnSeat;
    });
    if (!actor) { await wait(30); continue; }
    const la = actor.priv.you.legalActions;
    if (!la) { await wait(30); continue; }
    const before = actor.state.hand.number;
    if (la.check) actor.send({ type: 'action', action: { type: 'check' } });
    else if (la.call) actor.send({ type: 'action', action: { type: 'call' } });
    else actor.send({ type: 'action', action: { type: 'fold' } });
    await waitFor(() => actor.state && (actor.state.hand.complete || actor.state.hand.turnSeat !== turnSeat || actor.state.hand.street), 2000).catch(() => {});
    await wait(40);
  }

  check('hand reached completion', a.state.hand && a.state.hand.complete === true);
  check('a winner was recorded', a.state.hand.results && a.state.hand.results.some((r) => r.won > 0));

  const totalChips = a.state.players.reduce((s, p) => s + p.stack, 0);
  check('chips conserved (2000 total)', totalChips === 2000);

  console.log(a.state.hand.log.join('\n'));

  a.ws.close();
  b.ws.close();
  console.log(failures === 0 ? '\nALL INTEGRATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
