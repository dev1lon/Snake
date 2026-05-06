import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Check,
  Pause,
  Play,
  RotateCcw,
  Save
} from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { encodeFunctionData, type Address } from "viem";
import { useAccount, useConnect, useSendCalls, useSwitchChain } from "wagmi";
import { base } from "wagmi/chains";
import { WalletConnect } from "./WalletConnect";
import { snakeRecordsAbi } from "./contracts";

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

type Action =
  | { type: "start" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "move"; direction: Direction }
  | { type: "turnAndTick"; direction: Direction }
  | { type: "ensureFood" }
  | { type: "tick" };

type StreakState = {
  authenticated: boolean;
  canCheckIn: boolean;
  checkedInToday: boolean;
  expiresAt: string | null;
  nextCheckInAt: string | null;
  streak: number;
};

const BOARD_CELLS = 16;
const TOTAL_CELLS = BOARD_CELLS * BOARD_CELLS;
const START_LENGTH = 1;
const STEP_MS = 236;
const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL);
const RECORD_CONTRACT_ADDRESS = getAddressEnv(import.meta.env.VITE_RECORD_CONTRACT_ADDRESS);
const PAYMASTER_URL = import.meta.env.VITE_PAYMASTER_URL;
const ADMIN_NOTIFICATION_KEY = import.meta.env.VITE_ADMIN_NOTIFICATION_KEY;

const vectors: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

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

function isFoodValid(food: Point | null, snake: Point[]) {
  return Boolean(
    food &&
      food.x >= 0 &&
      food.y >= 0 &&
      food.x < BOARD_CELLS &&
      food.y < BOARD_CELLS &&
      !snake.some((part) => samePoint(part, food))
  );
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

function getDirectionFromKeyboard(event: KeyboardEvent): Direction | undefined {
  const keyMap: Record<string, Direction | undefined> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    w: "up",
    s: "down",
    a: "left",
    d: "right"
  };
  const codeMap: Record<string, Direction | undefined> = {
    KeyW: "up",
    KeyS: "down",
    KeyA: "left",
    KeyD: "right"
  };

  return keyMap[event.key] ?? keyMap[event.key.toLowerCase()] ?? codeMap[event.code];
}

function normalizeApiUrl(value: string | undefined) {
  if (!value) {
    return "http://localhost:4000";
  }

  return value.startsWith("http") ? value : `https://${value}`;
}

function getAddressEnv(value: string | undefined): Address | null {
  return value && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value as Address) : null;
}

function ensureFoodOnState(state: GameState): GameState {
  if (state.status === "won" || state.snake.length >= TOTAL_CELLS || isFoodValid(state.food, state.snake)) {
    return state;
  }

  return { ...state, food: getFood(state.snake) };
}

function advanceGame(state: GameState, forcedDirection?: Direction): GameState {
  if (state.status !== "running") {
    return state;
  }

  const cleanState = ensureFoodOnState(state);
  const requestedDirection = forcedDirection ?? cleanState.queuedDirection;
  const direction =
    cleanState.snake.length > 1 && isOpposite(cleanState.direction, requestedDirection)
      ? cleanState.direction
      : requestedDirection;
  const currentFood = isFoodValid(cleanState.food, cleanState.snake)
    ? cleanState.food
    : getFood(cleanState.snake);
  const head = cleanState.snake[0];
  const vector = vectors[direction];
  const nextHead = { x: head.x + vector.x, y: head.y + vector.y };
  const outOfBounds =
    nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= BOARD_CELLS || nextHead.y >= BOARD_CELLS;
  const eating = currentFood ? samePoint(nextHead, currentFood) : false;
  const collisionBody = eating ? cleanState.snake : cleanState.snake.slice(0, -1);
  const selfHit = collisionBody.some((part) => samePoint(part, nextHead));

  if (outOfBounds || selfHit) {
    return {
      ...cleanState,
      direction,
      queuedDirection: direction,
      status: "lost",
      score: calculateScore(cleanState.snake.length, cleanState.moves, false)
    };
  }

  const nextSnake = eating
    ? [nextHead, ...cleanState.snake]
    : [nextHead, ...cleanState.snake.slice(0, -1)];
  const won = nextSnake.length === TOTAL_CELLS;
  const moves = cleanState.moves + 1;

  return {
    ...cleanState,
    snake: nextSnake,
    food: won ? null : eating || !currentFood ? getFood(nextSnake) : currentFood,
    direction,
    queuedDirection: direction,
    moves,
    status: won ? "won" : "running",
    score: calculateScore(nextSnake.length, moves, won)
  };
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

    case "ensureFood":
      return ensureFoodOnState(state);

    case "turnAndTick":
      if (state.status !== "running") {
        return state;
      }

      if (state.snake.length > 1 && isOpposite(state.direction, action.direction)) {
        return state;
      }

      return advanceGame({ ...state, queuedDirection: action.direction }, action.direction);

    case "tick":
      return advanceGame(state);

    default:
      return state;
  }
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const coinImageRef = useRef<HTMLImageElement | null>(null);
  const animationFrameRef = useRef(0);
  const accumulatorRef = useRef(0);
  const gameRef = useRef<GameState>(createGame());
  const lastFrameAtRef = useRef(0);
  const stepStartedAtRef = useRef(0);
  const targetSnakeRef = useRef<Point[]>(gameRef.current.snake);
  const previousSnakeRef = useRef<Point[]>(gameRef.current.snake);
  const [game, dispatch] = useReducer(reducer, undefined, () => createGame());
  const [activeDirection, setActiveDirection] = useState<Direction | null>(null);
  const [coinReady, setCoinReady] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [recordStatus, setRecordStatus] = useState<string | null>(null);
  const [streak, setStreak] = useState<StreakState | null>(null);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [streakStatus, setStreakStatus] = useState<string | null>(null);
  const { address, connector, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { sendCallsAsync, isPending: isSavingRecord } = useSendCalls();
  const { switchChainAsync } = useSwitchChain();

  const filledPercent = Math.round((game.snake.length / TOTAL_CELLS) * 100);
  const gameEnded = game.status === "lost" || game.status === "won";
  const baseAccountConnector = useMemo(
    () => connectors.find((availableConnector) => availableConnector.id === "baseAccount"),
    [connectors]
  );
  const streakExpiresMs = streak?.expiresAt ? new Date(streak.expiresAt).getTime() : 0;
  const streakTimeLeft = Math.max(0, streakExpiresMs - nowMs);

  const queueDirection = (direction: Direction) => {
    const liveGame = gameRef.current;
    const canTurn = liveGame.snake.length <= 1 || !isOpposite(liveGame.direction, direction);
    const isNewDirection = liveGame.queuedDirection !== direction;

    if (liveGame.status === "running" && canTurn && isNewDirection) {
      accumulatorRef.current = 0;
      dispatch({ type: "turnAndTick", direction });
      return;
    }

    dispatch({ type: "move", direction });
  };

  useEffect(() => {
    const image = new Image();
    image.src = "/coin.png";
    image.onload = () => setCoinReady(true);
    image.onerror = () => setCoinReady(false);
    coinImageRef.current = image;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const loadStreak = async () => {
      try {
        const response = await fetch(`${API_URL}/api/streak`, {
          credentials: "include"
        });

        if (!response.ok) {
          setStreak(null);
          return;
        }

        setStreak((await response.json()) as StreakState);
      } catch {
        setStreak(null);
      }
    };

    void loadStreak();
  }, [address, isConnected]);

  useEffect(() => {
    if (game.status !== "won" && game.snake.length < TOTAL_CELLS && !isFoodValid(game.food, game.snake)) {
      dispatch({ type: "ensureFood" });
    }
  }, [game.food, game.snake, game.status]);

  useEffect(() => {
    const snakeChanged = game.snake !== targetSnakeRef.current;

    if (snakeChanged) {
      previousSnakeRef.current = targetSnakeRef.current;
      targetSnakeRef.current = game.snake;
      stepStartedAtRef.current = performance.now();
    }

    if (game.status !== "running") {
      previousSnakeRef.current = game.snake;
      targetSnakeRef.current = game.snake;
      accumulatorRef.current = 0;
    }

    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      if (isTyping) {
        return;
      }

      const direction = getDirectionFromKeyboard(event);

      if (direction) {
        event.preventDefault();
        setActiveDirection(direction);
        queueDirection(direction);
      }

      if (event.key === " ") {
        event.preventDefault();
        dispatch({ type: game.status === "running" ? "pause" : "start" });
      }

      if (event.key === "Escape" && (game.status === "running" || game.status === "paused")) {
        event.preventDefault();
        dispatch({ type: "pause" });
      }

      if (event.key === "r" || event.key === "R") {
        dispatch({ type: "reset" });
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      if (isTyping) {
        return;
      }

      const direction = getDirectionFromKeyboard(event);

      if (direction) {
        setActiveDirection((current) => (current === direction ? null : current));
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
    };
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
    const drawFrame = (now: number) => {
      const devicePixelRatio = window.devicePixelRatio || 1;
      const lastFrameAt = lastFrameAtRef.current || now;
      const delta = Math.min(80, now - lastFrameAt);
      const liveGame = gameRef.current;

      lastFrameAtRef.current = now;
      if (
        canvas.width !== logicalSize * devicePixelRatio ||
        canvas.height !== logicalSize * devicePixelRatio
      ) {
        canvas.width = logicalSize * devicePixelRatio;
        canvas.height = logicalSize * devicePixelRatio;
        context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      }

      if (liveGame.status === "running") {
        accumulatorRef.current += delta;

        if (accumulatorRef.current >= STEP_MS) {
          accumulatorRef.current -= STEP_MS;
          dispatch({ type: "tick" });
        }
      }

      const progress =
        liveGame.status === "running" ? Math.min(1, (now - stepStartedAtRef.current) / STEP_MS) : 1;
      const easedProgress = easeOutCubic(progress);
      const drawableGame = ensureFoodOnState(liveGame);
      const renderGame = {
        ...drawableGame,
        snake: interpolateSnake(previousSnakeRef.current, targetSnakeRef.current, easedProgress)
      };

      drawGame(context, logicalSize, renderGame, coinReady ? coinImageRef.current : null);

      animationFrameRef.current = requestAnimationFrame(drawFrame);
    };

    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = requestAnimationFrame(drawFrame);

    return () => cancelAnimationFrame(animationFrameRef.current);
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

  const releaseFocus = () => {
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
  };

  const pressDirection = (direction: Direction) => {
    setActiveDirection(direction);
    queueDirection(direction);
    releaseFocus();
  };

  const releaseDirection = (direction: Direction) => {
    setActiveDirection((current) => (current === direction ? null : current));
  };

  const checkIn = async () => {
    setStreakStatus(null);
    setIsCheckingIn(true);

    try {
      if (RECORD_CONTRACT_ADDRESS && (!streak || streak.canCheckIn)) {
        let activeConnector = connector;
        let activeAddress = address;

        if (!activeAddress && baseAccountConnector) {
          const connected = await connectAsync({ connector: baseAccountConnector });
          activeConnector = baseAccountConnector;
          activeAddress = connected.accounts[0];
        }

        if (!activeAddress) {
          throw new Error("Connect wallet first");
        }

        await switchChainAsync({ chainId: base.id });

        const data = encodeFunctionData({
          abi: snakeRecordsAbi,
          functionName: "checkIn"
        });
        const capabilities = PAYMASTER_URL
          ? {
              paymasterService: {
                url: PAYMASTER_URL
              }
            }
          : undefined;

        await sendCallsAsync({
          calls: [
            {
              data,
              to: RECORD_CONTRACT_ADDRESS
            }
          ],
          capabilities,
          chainId: base.id,
          connector: activeConnector,
          experimental_fallback: true
        });
      }

      const response = await fetch(`${API_URL}/api/streak/check-in`, {
        method: "POST",
        credentials: "include"
      });
      const data = (await response.json().catch(() => null)) as (StreakState & { error?: string }) | null;

      if (!response.ok || !data) {
        throw new Error(data?.error ?? "Check-in failed");
      }

      setStreak(data);
      setStreakStatus(data.checkedInToday ? "Checked in" : "Already active");
    } catch (caught) {
      setStreakStatus(caught instanceof Error ? caught.message : "Check-in failed");
    } finally {
      setIsCheckingIn(false);
    }
  };

  const sendAdminNotification = async () => {
    setStreakStatus(null);

    try {
      const response = await fetch(`${API_URL}/api/admin/notify-random`, {
        method: "POST",
        headers: ADMIN_NOTIFICATION_KEY ? { "x-admin-key": ADMIN_NOTIFICATION_KEY } : undefined
      });
      const data = (await response.json().catch(() => null)) as { error?: string; sentCount?: number } | null;

      if (!response.ok) {
        throw new Error(data?.error ?? "Notification failed");
      }

      setStreakStatus(`Sent ${data?.sentCount ?? 0}`);
    } catch (caught) {
      setStreakStatus(caught instanceof Error ? caught.message : "Notification failed");
    }
  };

  const saveRecord = async () => {
    if (!gameEnded) {
      return;
    }

    if (!RECORD_CONTRACT_ADDRESS) {
      setRecordStatus("Set VITE_RECORD_CONTRACT_ADDRESS after deploy");
      return;
    }

    setRecordStatus(null);

    try {
      let activeConnector = connector;
      let activeAddress = address;

      if (!activeAddress && baseAccountConnector) {
        const connected = await connectAsync({ connector: baseAccountConnector });
        activeConnector = baseAccountConnector;
        activeAddress = connected.accounts[0];
      }

      if (!activeAddress) {
        throw new Error("Connect wallet first");
      }

      await switchChainAsync({ chainId: base.id });

      const data = encodeFunctionData({
        abi: snakeRecordsAbi,
        functionName: "recordRun",
        args: [BigInt(game.score), game.snake.length, game.status === "won", BigInt(game.moves)]
      });
      const capabilities = PAYMASTER_URL
        ? {
            paymasterService: {
              url: PAYMASTER_URL
            }
          }
        : undefined;
      const result = await sendCallsAsync({
        calls: [
          {
            data,
            to: RECORD_CONTRACT_ADDRESS
          }
        ],
        capabilities,
        chainId: base.id,
        connector: activeConnector,
        experimental_fallback: true
      });

      setRecordStatus(`Record sent ${result.id.slice(0, 10)}...`);
    } catch (caught) {
      setRecordStatus(caught instanceof Error ? caught.message : "Record transaction failed");
    }
  };

  return (
    <main className="app">
      <WalletConnect />
      <section className="game-area" aria-label="Snake game board">
        <div className="top-bar">
          <div>
            <p className="eyebrow">Snake</p>
            <h1>{statusText}</h1>
          </div>
          <div className="stats" aria-label="Game stats">
            <span>{game.score}</span>
            <span>{game.snake.length}/{TOTAL_CELLS}</span>
            <span>{filledPercent}%</span>
          </div>
          <div className="top-actions" aria-label="Snake actions">
            <button
              className="checkin-button"
              type="button"
              onClick={checkIn}
              disabled={isCheckingIn}
              title="Check in"
              aria-label="Check in"
            >
              <Check />
              <span>{streak?.streak ?? 0}</span>
              <small>{streakTimeLeft > 0 ? formatDuration(streakTimeLeft) : "ready"}</small>
            </button>
            <button
              className="admin-notify-button"
              type="button"
              onClick={sendAdminNotification}
              title="Send random Base App notification"
              aria-label="Send random Base App notification"
            >
              <Bell />
            </button>
          </div>
        </div>

        <div className="canvas-shell">
          <canvas ref={canvasRef} aria-label="Snake board" />
          {game.status === "paused" && (
            <div className="board-pause-mark" aria-hidden="true">
              <span />
              <span />
            </div>
          )}
          {game.status !== "running" && game.status !== "paused" && (
            <div className="overlay" aria-live="polite">
              <strong>{game.status === "idle" ? "Press play" : statusText}</strong>
              <span>
                {game.status === "won"
                  ? "The snake filled every cell."
                  : game.status === "lost"
                    ? "Restart and try to fill the full board."
                    : "Fill the board to finish the game."}
              </span>
              {gameEnded && (
                <button
                  className="save-record-button"
                  type="button"
                  disabled={isSavingRecord}
                  onClick={saveRecord}
                >
                  <Save />
                  <span>{isSavingRecord ? "Saving..." : "Save record"}</span>
                </button>
              )}
              {(recordStatus || streakStatus) && (
                <small className="action-status">{recordStatus ?? streakStatus}</small>
              )}
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
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dispatch({ type: "reset" });
                  releaseFocus();
                }}
              >
                <RotateCcw />
              </button>
            ) : (
              <span className="dpad-spacer restart" aria-hidden="true" />
            )}
            <button
              className={`dpad-button up ${activeDirection === "up" ? "is-active" : ""}`}
              type="button"
              title="Up"
              aria-label="Up"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                pressDirection("up");
              }}
              onPointerLeave={() => releaseDirection("up")}
              onPointerUp={() => releaseDirection("up")}
            >
              <ArrowUp />
            </button>
            <button
              className={`dpad-button left ${activeDirection === "left" ? "is-active" : ""}`}
              type="button"
              title="Left"
              aria-label="Left"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                pressDirection("left");
              }}
              onPointerLeave={() => releaseDirection("left")}
              onPointerUp={() => releaseDirection("left")}
            >
              <ArrowLeft />
            </button>
            <button
              className="dpad-center"
              type="button"
              title={
                game.status === "running" ? "Pause" : game.status === "paused" ? "Resume" : "Start"
              }
              aria-label={
                game.status === "running" ? "Pause" : game.status === "paused" ? "Resume" : "Start"
              }
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                dispatch({ type: game.status === "running" ? "pause" : "start" });
                releaseFocus();
              }}
            >
              {game.status === "running" ? <Pause /> : <Play />}
            </button>
            <button
              className={`dpad-button right ${activeDirection === "right" ? "is-active" : ""}`}
              type="button"
              title="Right"
              aria-label="Right"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                pressDirection("right");
              }}
              onPointerLeave={() => releaseDirection("right")}
              onPointerUp={() => releaseDirection("right")}
            >
              <ArrowRight />
            </button>
            <button
              className={`dpad-button down ${activeDirection === "down" ? "is-active" : ""}`}
              type="button"
              title="Down"
              aria-label="Down"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                pressDirection("down");
              }}
              onPointerLeave={() => releaseDirection("down")}
              onPointerUp={() => releaseDirection("down")}
            >
              <ArrowDown />
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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

function drawGame(
  context: CanvasRenderingContext2D,
  size: number,
  game: GameState,
  coinImage: HTMLImageElement | null
) {
  const cell = size / BOARD_CELLS;

  context.clearRect(0, 0, size, size);
  context.fillStyle = "#07162b";
  context.fillRect(0, 0, size, size);

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
  const inset = cell * 0.04;
  const x = food.x * cell + inset;
  const y = food.y * cell + inset;
  const size = cell - inset * 2;

  if (coinImage?.complete && coinImage.naturalWidth > 0) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
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
