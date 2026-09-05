# Base Snake

Snake on Base. React frontend, Express backend, SnakeArcade for paid runs and
revives, and SnakeRecords for daily check-ins.

The app is a plain web app — it runs in a normal browser and inside Base App
with the same code path, using the Base Account connector.

## Local development

```bash
npm install          # installs root, backend and frontend
cp .env.example backend/.env
cp .env.example frontend/.env
npm run dev          # backend on :4000, frontend on :5173
```

Use Node.js 22.13 or newer. The backend loads its local `.env` without overriding
variables already supplied by the host.

`npm run lint` type-checks both packages. `npm run build` builds both.
`npm test` runs the API and pending-run tests. To also exercise production
startup and migration from the previous schema, set `SNAKE_TEST_DATABASE_URL`
to a disposable PostgreSQL database. Tests create and remove their own schema.

## Configuration

Every variable is documented in [.env.example](.env.example). Production values
live in the Render dashboard; the service shape is in [render.yaml](render.yaml).

Two of them decide how the app behaves rather than just where it points:

- **`FRONTEND_ORIGIN`** (plus `ADDITIONAL_ORIGINS`) is the single allowlist
  behind CORS, the CSRF origin check and the domains a SIWE message may carry.
  A host that isn't listed cannot sign in.
- **`DATABASE_URL`** is required in production so paid revive usage, runs and
  sessions survive restarts. Development can use memory. The backend starts
  listening only after its database schema has initialized successfully.

### RPC with paymaster disabled

In [CDP Node](https://docs.cdp.coinbase.com/data/node/quickstart), choose Base
Mainnet and copy the endpoint into the backend's `RPC_URL` on Render:
`https://api.developer.coinbase.com/rpc/v1/base/<client-api-key>`.
Gas sponsorship is controlled in CDP. `CDP_PAYMASTER_URL` configures the proxy
endpoint; it does not indicate whether sponsorship is enabled there.
RPC reads work independently of the sponsorship setting.
An independently configured Base RPC provider works too.

For Render Postgres in the same region, use its Internal Database URL for
`DATABASE_URL`. Enable `DATABASE_SSL` only if that connection requires TLS.
Existing tables and `recorded_runs` are preserved. Optional `VITE_RPC_URL` is a
browser-visible, domain-restricted endpoint and requires a frontend rebuild.

## Game modes

- **Classic** (`/game?mode=classic`) — the 16×16 board, won by filling it.
- **Levels** (`/game?mode=levels`) — six boards that double in size, alternating
  wide and tall so the cells stay square: 8×4, 8×8, 16×8, 16×16, 32×16, 32×32.
  Each one is cleared at a quota rather than a full fill (16 → 154 cells), and
  the highest level reached is kept in `localStorage`. The ladder lives in
  [levels.ts](frontend/src/levels.ts); 32×32 is the last level because smaller
  cells stop being readable on a phone.

## Revives and saving

Crashing offers a revive: the run resumes where it died, with the same score and
move count, and with real space to move — if the head is walled in the snake
turns around, and it gives up length only when even that isn't enough.

Both revives and saving are paid through
[SnakeArcade](contracts/SnakeArcade.sol):

- one revive, $1, sold only at the crash;
- packs of twenty, $10, sold in the shop, any number of packs at a time;
- saving a run, $0.10, charged the same in classic and in levels.

The prices are held in cents and converted to ETH at payment time through the
Chainlink ETH/USD feed, so a dollar stays a dollar as the market moves. The
frontend sends 2% over the quote and the contract refunds the difference. See
[contracts/README.md](contracts/README.md).

Revives are counted onchain (`revivesPurchased` only grows) and spent through
`POST /api/revives/use`; the balance a player sees is the difference. The deployed
Base mainnet contract is used by default. Revives require a confirmed purchase;
there is no local balance that grants free purchases.

## Runs in the database

A score reaches Postgres through exactly one door: the transaction that recorded
it. `POST /api/runs` takes a transaction hash and nothing else — mode, level,
score, cells and moves are read back out of the contract's `RunRecorded` event,
so there is no number for a client to inflate. `runs` keeps every saved run,
`player_bests` keeps the best per `(address, mode, level)`, and classic always
sits at level 0 so the two modes can never overwrite each other.

Before a payment the frontend verifies that its backend session matches the
connected wallet. Submitted run references are queued locally, confirmed and
retried on game mount, sign-in, reconnect and every 30 seconds while the game
page is open. Retries sync the existing transaction without another payment.
If browser storage is blocked, the queue lasts only for that page session.
Revive consumption is serialized per player in Postgres and accepts an
`Idempotency-Key` so a lost response can be retried without another spend.

## Outside Base App

The app is built for the Base App webview, and [gate.html](frontend/public/gate.html)
is a standalone page linking to Base App. It uses plain HTML and CSS, with no
build step or scripts. Its button opens
`https://base.app/app/https://base-snake.app/`; the game's address is shown below it.

Production sends browsers outside Base App to `/gate.html`. Detection allows
600 ms for a late wallet provider to appear before redirecting. It remains
heuristic and is not a security boundary. The old `?web=1` and local storage
bypasses no longer apply. Local development stays open; `?gate=1` previews the
gate in any environment, and `/gate.html` is always directly accessible.

## Security posture

- **Sponsorship.** `/api/paymaster` proxies the CDP paymaster so the API key
  stays server-side. The contract and call-policy allowlist is configured in
  CDP; the proxy adds a per-account and a service-wide rate limit on top. It
  cannot require a session — sponsorship requests come from the wallet, not
  from our frontend.
- **Sign-in.** SIWE messages are rejected unless their domain is in the
  allowlist, so a signature produced on another site can't be replayed here.
- **CORS is not a boundary.** It only decides whether a browser lets a page
  read a response; the request runs either way. Every endpoint is reachable by
  any client, which is why the mutating ones check the origin and all of them
  are rate-limited.
- **Onchain records are self-reported.** `recordRun` accepts whatever score the
  client sends. Treat the events as an activity log, not a leaderboard, until
  the score is either derived in the contract or signed by the backend.

## Contract

Deployed on Base mainnet at `0x9e5d82E6B6419C066Bc57F5a70116659c468d780`.
See [contracts/README.md](contracts/README.md).
