# Base Snake

Snake on Base. React frontend, Express backend, one immutable contract
(`contracts/SnakeRecords.sol`) that records runs and daily check-ins.

The app is a plain web app — it runs in a normal browser and inside Base App
with the same code path, using the Base Account connector.

## Local development

```bash
npm install          # installs root, backend and frontend
cp .env.example backend/.env
cp .env.example frontend/.env
npm run dev          # backend on :4000, frontend on :5173
```

`npm run lint` type-checks both packages. `npm run build` builds both.

## Configuration

Every variable is documented in [.env.example](.env.example). Production values
live in the Render dashboard; the service shape is in [render.yaml](render.yaml).

Two of them decide how the app behaves rather than just where it points:

- **`FRONTEND_ORIGIN`** (plus `ADDITIONAL_ORIGINS`) is the single allowlist
  behind CORS, the CSRF origin check and the domains a SIWE message may carry.
  A host that isn't listed cannot sign in.
- **`DATABASE_URL`** decides whether sessions and streaks survive a restart.
  Without it both live in process memory, so they reset whenever the instance
  sleeps or redeploys.

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

Both revives and saving are paid, in ETH, through
[SnakeArcade](contracts/SnakeArcade.sol):

- one revive, sold only at the crash;
- packs of revives, sold in the shop, any number of packs at a time;
- saving a run, charged the same in classic and in levels.

Every price is a variable the contract owner can retune — see
[contracts/README.md](contracts/README.md).

Revives are counted onchain (`revivesPurchased` only grows) and spent through
`POST /api/revives/use`; the balance a player sees is the difference. Without
`VITE_ARCADE_CONTRACT_ADDRESS` the game runs a local sandbox instead: revives
are granted rather than sold, and nothing is written to the database.

## Runs in the database

A score reaches Postgres through exactly one door: the transaction that recorded
it. `POST /api/runs` takes a transaction hash and nothing else — mode, level,
score, cells and moves are read back out of the contract's `RunRecorded` event,
so there is no number for a client to inflate. `runs` keeps every saved run,
`player_bests` keeps the best per `(address, mode, level)`, and classic always
sits at level 0 so the two modes can never overwrite each other.

## Outside Base App

The app is built for the Base App webview, and [gate.html](frontend/public/gate.html)
is the page that sends other browsers to the mini app instead of letting them
into a half-working game. It is a standalone page — plain HTML and CSS, no
build step, no scripts, no env vars — so the Base App link is written directly
into its markup.

**The redirect is off.** Production serves the open web app; browsers are only
sent to `/gate.html` when `VITE_REQUIRE_BASE_APP=true`, which is worth turning
on once the page carries a real link. The page itself is always reachable at
`/gate.html`, and `?gate=1` on any route jumps to it. With the redirect on,
detection is heuristic and deliberately permissive, `?web=1` walks through it,
and dev servers never gate.

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
