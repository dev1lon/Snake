// Board sizes double from level to level. The grid grows wide, then tall, so the
// cell count stays a power of two and the board never gets flatter than 2:1 —
// past that a phone screen has nothing left to show.
export type BoardConfig = {
  cols: number;
  rows: number;
  // Length that clears the board. Filling 1024 cells completely is a chore, not
  // a game, so every level has a quota instead of the classic fill-it-all rule.
  goal: number;
};

export const CLASSIC_BOARD: BoardConfig = { cols: 16, rows: 16, goal: 256 };

export const LEVELS: BoardConfig[] = [
  { cols: 8, rows: 4, goal: 16 },
  { cols: 8, rows: 8, goal: 26 },
  { cols: 16, rows: 8, goal: 38 },
  { cols: 16, rows: 16, goal: 64 },
  { cols: 32, rows: 16, goal: 102 },
  { cols: 32, rows: 32, goal: 154 }
];

export const LAST_LEVEL_INDEX = LEVELS.length - 1;

const PROGRESS_KEY = "snake.levels.progress";

export function cellCount(board: BoardConfig) {
  return board.cols * board.rows;
}

export function getLevel(index: number): BoardConfig {
  return LEVELS[clampLevel(index)];
}

export function clampLevel(index: number) {
  if (!Number.isFinite(index)) {
    return 0;
  }

  return Math.min(LAST_LEVEL_INDEX, Math.max(0, Math.floor(index)));
}

// Highest level the player has unlocked. Local only for now — when levels move
// server-side this becomes a cache of the account's progress, not the source.
export function getLevelProgress() {
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    return clampLevel(raw ? Number.parseInt(raw, 10) : 0);
  } catch {
    return 0;
  }
}

export function storeLevelProgress(index: number) {
  try {
    window.localStorage.setItem(PROGRESS_KEY, String(clampLevel(index)));
  } catch {
    // Storage is blocked in some webviews; progress just won't survive a reload.
  }
}

// Best score per level, so a run reads as "level 3 · 1240" rather than as a
// bare number that says nothing about which board earned it.
const BEST_KEY = "snake.levels.best";

function readBestScores(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(BEST_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};

    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function getLevelBest(index: number) {
  const value = readBestScores()[String(clampLevel(index))];

  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function storeLevelBest(index: number, score: number) {
  const level = clampLevel(index);
  const best = Math.max(getLevelBest(level), Math.max(0, Math.floor(score)));

  try {
    window.localStorage.setItem(BEST_KEY, JSON.stringify({ ...readBestScores(), [level]: best }));
  } catch {
    // Same as progress: a blocked store costs the record, not the run.
  }

  return best;
}
