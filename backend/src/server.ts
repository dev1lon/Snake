import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";

type LeaderboardEntry = {
  id: string;
  name: string;
  score: number;
  cells: number;
  won: boolean;
  createdAt: string;
};

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendOrigin = process.env.FRONTEND_ORIGIN;
const leaderboard: LeaderboardEntry[] = [];

app.use(
  cors({
    origin: frontendOrigin ? [frontendOrigin, `https://${frontendOrigin}`] : true
  })
);
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/leaderboard", (_req, res) => {
  res.json({
    entries: leaderboard
      .slice()
      .sort((a, b) => b.score - a.score || Number(b.won) - Number(a.won))
      .slice(0, 10)
  });
});

app.post("/api/leaderboard", (req, res) => {
  const { name, score, cells, won } = req.body as Partial<LeaderboardEntry>;

  if (
    typeof name !== "string" ||
    typeof score !== "number" ||
    typeof cells !== "number" ||
    typeof won !== "boolean"
  ) {
    res.status(400).json({ error: "Invalid leaderboard payload." });
    return;
  }

  const entry: LeaderboardEntry = {
    id: randomUUID(),
    name: name.trim().slice(0, 18) || "Player",
    score: Math.max(0, Math.floor(score)),
    cells: Math.max(0, Math.floor(cells)),
    won,
    createdAt: new Date().toISOString()
  };

  leaderboard.push(entry);
  leaderboard.sort((a, b) => b.score - a.score || Number(b.won) - Number(a.won));
  leaderboard.splice(50);

  res.status(201).json({ entry });
});

app.listen(port, () => {
  console.log(`Sneak backend listening on http://localhost:${port}`);
});
