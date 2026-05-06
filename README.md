# Snake

Classic phone-style snake game: the top half is the game board, the bottom half is a large directional control panel.

## Stack

- Frontend: React + Vite + TypeScript + Canvas
- Backend: Node.js + Express + TypeScript
- Future deploy: Render with separate frontend/backend services

## Local Run

```bash
npm run install:all
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:4000`

## Render

Frontend-only manual service from the repo root:

```bash
npm run render:frontend
```

Publish directory:

```bash
frontend/dist
```

Backend manual service from the repo root:

```bash
npm run render:backend
```

Start command:

```bash
npm run start
```

If a Render service uses `backend` as Root Directory instead of repo root, use:

```bash
npm install --include=dev && npm run build
```

Start command for `backend` Root Directory:

```bash
npm run start
```

If using `render.yaml`, Render uses `frontend` and `backend` as separate service roots.

## MVP

The player wins when the snake fills the whole board. A local backend stores leaderboard results for the current server process. Base Account, wallet login, and onchain achievements can be added in the next stage.

## Onchain + Base App

Deploy `contracts/SnakeRecords.sol` to Base mainnet, then set:

```bash
VITE_RECORD_CONTRACT_ADDRESS=0x9e5d82E6B6419C066Bc57F5a70116659c468d780
VITE_PAYMASTER_URL=https://...
```

For Base App notifications and admin broadcast:

```bash
BASE_API_KEY=...
ADMIN_WALLET_ADDRESS=0x...
```

`BASE_APP_URL` is optional. If it is not set, the backend uses `FRONTEND_ORIGIN`.

Gasless record/check-in writes require the deployed contract to be allowlisted in your Base/CDP paymaster policy.
