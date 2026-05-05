import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Pause,
  Play,
  RotateCcw,
  Save,
  Trophy
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

type Point = {
  x: number;
  y: number;
};

type Direction = "up" | "down" | "left" | "right";
type GameStatus = "idle" | "running" | "paused" | "lost" | "won";

type GameState = {
  snake: Point[];
  food: Point | null;
  direction: Direction;
  queuedDirection: Direction;
  score: number;
  moves: number;
  status: GameStatus;
};

type LeaderboardEntry = {
  id: string;
  name: string;
  score: number;
  cells: number;
  won: boolean;
  createdAt: string;
};

type Action =
  | { type: "start" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "move"; direction: Direction }
  | { type: "tick" };

const BOARD_CELLS = 16;
const TOTAL_CELLS = BOARD_CELLS * BOARD_CELLS;
const START_LENGTH = 1;
const STEP_MS = 236;
const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL);

const vectors: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

function normalizeApiUrl(value: string | undefined) {
  if (!value) {
    return "http://localhost:4000";
  }

  return value.startsWith("http") ? value : `https://${value}`;
}

function samePoint(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y;
}

function isOpposite(a: Direction, b: Direction) {
  return (
    (a === "up" && b === "down") ||
    (a === "down" && b === "up") ||
    (a === "left" && b === "right") ||
    (a === "right" && b === "left")
  );
}

function makeInitialSnake(): Point[] {
  const y = Math.floor(BOARD_CELLS / 2);
  const x = Math.floor(BOARD_CELLS / 2);

  return [{ x, y }];
}

function getFood(snake: Point[]): Point | null {
  const freeCells: Point[] = [];

  for (let y = 0; y < BOARD_CELLS; y += 1) {
    for (let x = 0; x < BOARD_CELLS; x += 1) {
      const cell = { x, y };

      if (!snake.some((part) => samePoint(part, cell))) {
        freeCells.push(cell);
      }
    }
  }

  if (freeCells.length === 0) {
    return null;
  }

  return freeCells[Math.floor(Math.random() * freeCells.length)];
}

function createGame(status: GameStatus = "idle"): GameState {
  const snake = makeInitialSnake();

  return {
    snake,
    food: getFood(snake),
    direction: "right",
    queuedDirection: "right",
    score: 0,
    moves: 0,
    status
  };
}

function calculateScore(length: number, moves: number, won: boolean) {
  const cellsScore = (length - START_LENGTH) * 100;
  const efficiencyBonus = Math.max(0, 900 - moves);

  return cellsScore + efficiencyBonus + (won ? 3000 : 0);
}

function reducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "start":
      if (state.status === "idle" || state.status === "lost" || state.status === "won") {
        return createGame("running");
      }

      return { ...state, status: "running" };

    case "pause":
      if (state.status === "running") {
        return { ...state, status: "paused" };
      }

      if (state.status === "paused") {
        return { ...state, status: "running" };
      }

      return state;

    case "reset":
      return createGame("idle");

    case "move":
      if (state.snake.length > 1 && isOpposite(state.direction, action.direction)) {
        return state;
      }

      return { ...state, queuedDirection: action.direction };

    case "tick": {
      if (state.status !== "running") {
        return state;
      }

      const direction = state.queuedDirection;
      const head = state.snake[0];
      const vector = vectors[direction];
      const nextHead = { x: head.x + vector.x, y: head.y + vector.y };
      const outOfBounds =
        nextHead.x < 0 ||
        nextHead.y < 0 ||
        nextHead.x >= BOARD_CELLS ||
        nextHead.y >= BOARD_CELLS;
      const eating = state.food ? samePoint(nextHead, state.food) : false;
      const collisionBody = eating ? state.snake : state.snake.slice(0, -1);
      const selfHit = collisionBody.some((part) => samePoint(part, nextHead));

      if (outOfBounds || selfHit) {
        return {
          ...state,
          direction,
          status: "lost",
          score: calculateScore(state.snake.length, state.moves, false)
        };
      }

      const nextSnake = eating
        ? [nextHead, ...state.snake]
        : [nextHead, ...state.snake.slice(0, -1)];
      const won = nextSnake.length === TOTAL_CELLS;
      const moves = state.moves + 1;

      return {
        ...state,
        snake: nextSnake,
        food: won ? null : eating ? getFood(nextSnake) : state.food,
        direction,
        moves,
        status: won ? "won" : "running",
        score: calculateScore(nextSnake.length, moves, won)
      };
    }

    default:
      return state;
  }
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const coinImageRef = useRef<HTMLImageElement | null>(null);
  const gameRef = useRef<GameState>(createGame());
  const previousSnakeRef = useRef<Point[]>(gameRef.current.snake);
  const targetSnakeRef = useRef<Point[]>(gameRef.current.snake);
  const animationStartRef = useRef(0);
  const [game, dispatch] = useReducer(reducer, undefined, () => createGame());
  const [playerName, setPlayerName] = useState("Player");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [coinReady, setCoinReady] = useState(false);

  const filledPercent = Math.round((game.snake.length / TOTAL_CELLS) * 100);
  const gameFinished = game.status === "lost" || game.status === "won";

  const fetchLeaderboard = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/leaderboard`);
      const data = (await response.json()) as { entries: LeaderboardEntry[] };
      setLeaderboard(data.entries);
    } catch {
      setLeaderboard([]);
    }
  }, []);

  useEffect(() => {
    void fetchLeaderboard();
  }, [fetchLeaderboard]);

  useEffect(() => {
    const image = new Image();
    image.src = "/coin.png";
    image.onload = () => setCoinReady(true);
    image.onerror = () => setCoinReady(false);
    coinImageRef.current = image;
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => dispatch({ type: "tick" }), STEP_MS);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    previousSnakeRef.current = targetSnakeRef.current;
    targetSnakeRef.current = game.snake;
    gameRef.current = game;
    animationStartRef.current = performance.now();
  }, [game]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const keyMap: Record<string, Direction | undefined> = {
        ArrowUp: "up",
        w: "up",
        W: "up",
        ArrowDown: "down",
        s: "down",
        S: "down",
        ArrowLeft: "left",
        a: "left",
        A: "left",
        ArrowRight: "right",
        d: "right",
        D: "right"
      };
      const direction = keyMap[event.key];

      if (direction) {
        event.preventDefault();
        dispatch({ type: "move", direction });
      }

      if (event.key === " ") {
        event.preventDefault();
        dispatch({ type: game.status === "running" ? "pause" : "start" });
      }

      if (event.key === "r" || event.key === "R") {
        dispatch({ type: "reset" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [game.status]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    const logicalSize = 720;
    let frame = 0;

    const render = (now: number) => {
      const devicePixelRatio = window.devicePixelRatio || 1;

      if (
        canvas.width !== logicalSize * devicePixelRatio ||
        canvas.height !== logicalSize * devicePixelRatio
      ) {
        canvas.width = logicalSize * devicePixelRatio;
        canvas.height = logicalSize * devicePixelRatio;
        context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      }

      const progress = Math.min(1, (now - animationStartRef.current) / STEP_MS);
      const easedProgress = easeOutCubic(progress);
      const renderGame = {
        ...gameRef.current,
        snake: interpolateSnake(previousSnakeRef.current, targetSnakeRef.current, easedProgress)
      };

      drawGame(context, logicalSize, renderGame, coinReady ? coinImageRef.current : null);
      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);

    return () => cancelAnimationFrame(frame);
  }, [coinReady]);

  const statusText = useMemo(() => {
    if (game.status === "won") {
      return "Screen filled";
    }

    if (game.status === "lost") {
      return "Crash";
    }

    if (game.status === "paused") {
      return "Paused";
    }

    if (game.status === "running") {
      return "Running";
    }

    return "Ready";
  }, [game.status]);

  const saveScore = async () => {
    setSaveState("saving");

    try {
      const response = await fetch(`${API_URL}/api/leaderboard`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: playerName,
          score: game.score,
          cells: game.snake.length,
          won: game.status === "won"
        })
      });

      if (!response.ok) {
        throw new Error("Failed to save score.");
      }

      setSaveState("saved");
      await fetchLeaderboard();
    } catch {
      setSaveState("error");
    }
  };

  const move = (direction: Direction) => {
    dispatch({ type: "move", direction });
  };

  return (
    <main className="app">
      <section className="game-area" aria-label="Snake game board">
        <div className="top-bar">
          <div>
            <p className="eyebrow">Sneak</p>
            <h1>{statusText}</h1>
          </div>
          <div className="stats" aria-label="Game stats">
            <span>{game.score}</span>
            <span>{game.snake.length}/{TOTAL_CELLS}</span>
            <span>{filledPercent}%</span>
          </div>
        </div>

        <div className="canvas-shell">
          <canvas ref={canvasRef} aria-label="Snake board" />
          {game.status !== "running" && (
            <div className="overlay" aria-live="polite">
              <strong>{game.status === "idle" ? "Press play" : statusText}</strong>
              <span>
                {game.status === "won"
                  ? "The snake filled every cell."
                  : game.status === "lost"
                    ? "Restart and try to fill the full board."
                    : "Fill the board to finish the game."}
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="controls-area" aria-label="Snake controls">
        <div className="lower-grid">
          <div className="dpad" aria-label="Direction buttons">
            {game.status === "paused" ? (
              <button
                className="dpad-button restart"
                type="button"
                title="Restart"
                aria-label="Restart"
                onClick={() => dispatch({ type: "reset" })}
              >
                <RotateCcw />
              </button>
            ) : (
              <span className="dpad-spacer restart" aria-hidden="true" />
            )}
            <button
              className="dpad-button up"
              type="button"
              title="Up"
              aria-label="Up"
              onClick={() => move("up")}
            >
              <ArrowUp />
            </button>
            <button
              className="dpad-button left"
              type="button"
              title="Left"
              aria-label="Left"
              onClick={() => move("left")}
            >
              <ArrowLeft />
            </button>
            <button
              className="dpad-center"
              type="button"
              title={game.status === "running" ? "Pause" : "Play"}
              aria-label={game.status === "running" ? "Pause" : "Play"}
              onClick={() => dispatch({ type: game.status === "running" ? "pause" : "start" })}
            >
              {game.status === "running" ? <Pause /> : <Play />}
            </button>
            <button
              className="dpad-button right"
              type="button"
              title="Right"
              aria-label="Right"
              onClick={() => move("right")}
            >
              <ArrowRight />
            </button>
            <button
              className="dpad-button down"
              type="button"
              title="Down"
              aria-label="Down"
              onClick={() => move("down")}
            >
              <ArrowDown />
            </button>
          </div>

          <div className="score-panel">
            <div className="leader-header">
              <Trophy />
              <span>Leaderboard</span>
            </div>

            {leaderboard.length === 0 ? (
              <p className="empty-state">No saved scores yet.</p>
            ) : (
              <ol className="leaderboard">
                {leaderboard.slice(0, 5).map((entry) => (
                  <li key={entry.id}>
                    <span>{entry.name}</span>
                    <strong>{entry.score}</strong>
                  </li>
                ))}
              </ol>
            )}

            <div className="save-row">
              <input
                aria-label="Player name"
                maxLength={18}
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
              />
              <button
                className="save-button"
                type="button"
                title="Save score"
                aria-label="Save score"
                disabled={!gameFinished || saveState === "saving"}
                onClick={saveScore}
              >
                <Save />
              </button>
            </div>
            <span className={`save-state ${saveState}`}>{formatSaveState(saveState)}</span>
          </div>
        </div>
      </section>
    </main>
  );
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function interpolateSnake(previousSnake: Point[], targetSnake: Point[], progress: number): Point[] {
  return targetSnake.map((target, index) => {
    const previous = previousSnake[index] ?? previousSnake[previousSnake.length - 1] ?? target;

    return {
      x: previous.x + (target.x - previous.x) * progress,
      y: previous.y + (target.y - previous.y) * progress
    };
  });
}

function formatSaveState(state: "idle" | "saving" | "saved" | "error") {
  switch (state) {
    case "saving":
      return "Saving...";
    case "saved":
      return "Saved";
    case "error":
      return "Backend offline";
    default:
      return "Save after finish";
  }
}

function drawGame(
  context: CanvasRenderingContext2D,
  size: number,
  game: GameState,
  coinImage: HTMLImageElement | null
) {
  const cell = size / BOARD_CELLS;

  context.clearRect(0, 0, size, size);
  context.fillStyle = "#07111f";
  context.fillRect(0, 0, size, size);

  for (let y = 0; y < BOARD_CELLS; y += 1) {
    for (let x = 0; x < BOARD_CELLS; x += 1) {
      context.fillStyle = (x + y) % 2 === 0 ? "#0c1d36" : "#08172b";
      context.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  context.strokeStyle = "rgba(0, 82, 255, 0.18)";
  context.lineWidth = 1;

  for (let i = 0; i <= BOARD_CELLS; i += 1) {
    const position = Math.round(i * cell) + 0.5;
    context.beginPath();
    context.moveTo(position, 0);
    context.lineTo(position, size);
    context.stroke();
    context.beginPath();
    context.moveTo(0, position);
    context.lineTo(size, position);
    context.stroke();
  }

  if (game.food) {
    drawCoin(context, game.food, cell, coinImage);
  }

  game.snake.forEach((part, index) => {
    const inset = cell * 0.08;
    const x = part.x * cell + inset;
    const y = part.y * cell + inset;
    const width = cell - inset * 2;
    const radius = Math.max(6, cell * 0.16);

    context.fillStyle = index === 0 ? "#0052ff" : index % 3 === 0 ? "#1b6dff" : "#0b5cff";
    roundedRect(context, x, y, width, width, radius);
    context.fill();

    if (index === 0) {
      context.fillStyle = "#ffffff";
      const eyeOffset = cell * 0.18;
      context.beginPath();
      context.arc(x + width * 0.34, y + eyeOffset + width * 0.22, cell * 0.055, 0, Math.PI * 2);
      context.arc(x + width * 0.66, y + eyeOffset + width * 0.22, cell * 0.055, 0, Math.PI * 2);
      context.fill();
    }
  });
}

function drawCoin(
  context: CanvasRenderingContext2D,
  food: Point,
  cell: number,
  coinImage: HTMLImageElement | null
) {
  const inset = cell * 0.12;
  const x = food.x * cell + inset;
  const y = food.y * cell + inset;
  const size = cell - inset * 2;

  if (coinImage?.complete && coinImage.naturalWidth > 0) {
    context.drawImage(coinImage, x, y, size, size);
    return;
  }

  const centerX = food.x * cell + cell / 2;
  const centerY = food.y * cell + cell / 2;
  const radius = cell * 0.36;

  context.fillStyle = "#0052ff";
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.arc(centerX, centerY, radius * 0.62, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#0052ff";
  context.fillRect(centerX - radius * 0.92, centerY - radius * 0.08, radius * 1.2, radius * 0.16);
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

export default App;
