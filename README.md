# ♠ Poker for Ganjutti

Private, invite-only **Texas Hold'em** you can play with friends anywhere in the world.
Play chips only, denominated in Bangladeshi taka (৳) — just for fun, no real money.

- **Server-authoritative:** the server shuffles, deals, validates every bet, and evaluates
  hands. Clients only ever receive their own hole cards, so nobody can cheat by inspecting
  the page.
- **No accounts:** create a table, share the invite link, friends join with a nickname.
- **Equal stacks:** everyone starts each session with the same stack (default ৳1000).
  No buy-ins, no rebuys, no cash-out. The host can reset everyone with "New session".
- **Reconnect-friendly:** drop your Wi-Fi and your seat is held; reopen the link to resume.
- **Turn timer:** a 45s timer auto-checks or folds so games never stall on an absent player.

## Run it locally

```bash
npm install
npm start
# open http://localhost:3000
```

Create a table in one browser, hit **Copy invite link**, and send it to your friends.
They open the link, type a nickname, and sit down. When at least two players are seated,
the host presses **Deal next hand**. Supports 2–9 players.

## Tests

```bash
npm test                 # unit tests: hand evaluator + betting engine + side pots
node test/integration.mjs   # end-to-end: two WebSocket clients play a full hand
                            #  (start the server first in another terminal)
```

## Deploy so friends abroad can reach it

Any host that runs a long-lived Node process and supports WebSockets works. The app reads
`PORT` from the environment. Two easy options:

**Render / Railway / Fly.io** — point it at this repo with:
- Build command: `npm install`
- Start command: `npm start`

That's it — share the deployed URL and everyone worldwide uses the same site.

## Project layout

```
src/engine/deck.js           cards, deck, shuffle (injectable RNG for tests)
src/engine/handEvaluator.js  best 5-of-7 hand ranking + comparison
src/engine/game.js           Table: seats, betting state machine, side pots, showdown
src/server.js                Express static host + WebSocket rooms, timers, reconnect
public/                      the web client (index.html / style.css / app.js)
test/                        unit + integration tests, plus a bot for manual play
```

## Notes / possible next steps

- The engine handles all-ins, multiway side pots, split pots, and heads-up blind rules.
- Under-raise all-ins let others call the extra; re-raise rights after a sub-minimum
  all-in are allowed (a minor simplification vs. strict tournament rules — fine for
  home games).
- Nice-to-haves not built yet: hand-history export, per-table chat, sound effects,
  rabbit-hunt/run-it-twice, and a spectator mode.
