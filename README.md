# Sneak

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

If using `render.yaml`, Render uses `frontend` and `backend` as separate service roots.

## MVP

The player wins when the snake fills the whole board. A local backend stores leaderboard results for the current server process. Base Account, wallet login, and onchain achievements can be added in the next stage.
