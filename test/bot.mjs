// A simple opponent bot for manual UI testing. Joins a table by code and
// checks/calls whenever it's their turn. Usage: node test/bot.mjs CODE [name]
import { WebSocket } from 'ws';

const PORT = process.env.PORT || 3000;
const code = (process.argv[2] || '').toUpperCase();
const name = process.argv[3] || 'Bot';
if (!code) { console.error('usage: node test/bot.mjs CODE [name]'); process.exit(1); }

const ws = new WebSocket(`ws://localhost:${PORT}`);
let myId = null;

ws.on('open', () => ws.send(JSON.stringify({ type: 'joinTable', code, name })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'joined') { myId = msg.playerId; console.log(`${name} joined ${code} as ${myId.slice(0, 8)}`); }
  if (msg.type === 'error') console.log('error:', msg.message);
  if (msg.type === 'state') {
    const { public: pub, private: priv } = msg;
    if (!pub.hand || pub.hand.complete) return;
    const me = pub.players.find((p) => p.id === myId);
    if (!me || pub.hand.turnSeat !== me.seat) return;
    const la = priv.you.legalActions;
    if (!la) return;
    setTimeout(() => {
      if (la.check) ws.send(JSON.stringify({ type: 'action', action: { type: 'check' } }));
      else if (la.call) ws.send(JSON.stringify({ type: 'action', action: { type: 'call' } }));
      else ws.send(JSON.stringify({ type: 'action', action: { type: 'fold' } }));
    }, 600);
  }
});
ws.on('close', () => process.exit(0));
console.log(`connecting bot "${name}" to table ${code}…`);
