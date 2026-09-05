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
