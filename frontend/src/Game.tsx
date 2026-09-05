import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  ChevronUp,
  Heart,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  X
} from "lucide-react";
import { waitForCallsStatus, waitForTransactionReceipt } from "@wagmi/core";
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { encodeFunctionData, formatEther, type Address, type Hex } from "viem";
import {
  useAccount,
  useCapabilities,
  useReadContracts,
  useSendCalls,
  useSwitchChain,
  useWriteContract
} from "wagmi";
import { base } from "wagmi/chains";
import { API_URL } from "./api";
import {
  ARCADE_ADDRESS,
  MODE_CLASSIC,
  MODE_LEVELS,
  snakeArcadeAbi,
  snakeRecordsAbi
} from "./contracts";
import {
  CLASSIC_BOARD,
  clampLevel,
  getLevel,
  getLevelBest,
  getLevelProgress,
  LAST_LEVEL_INDEX,
  storeLevelBest,
  storeLevelProgress,
  type BoardConfig
} from "./levels";
import {
  creditSandboxRevives,
  PAYMENTS_ARE_LIVE,
  refreshRevives,
  SANDBOX_PACK_REVIVES,
  spendRevive,
  useRevives
} from "./revives";
import { wagmiConfig } from "./wagmi";
import { authHeaders, getStoredIsAdmin, WalletConnect } from "./WalletConnect";

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
  // The board travels with the state: in level mode every level is a different
  // grid, and the reducer, the renderer and the HUD all read it from here.
  cols: number;
  rows: number;
  goal: number;
};

type Action =
  | { type: "start" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "loadBoard"; board: BoardConfig; start?: boolean }
  | { type: "startWithDirection"; direction: Direction }
  | { type: "revive" }
  | { type: "move"; direction: Direction }
  | { type: "turnAndTick"; direction: Direction }
  | { type: "ensureFood" }
  | { type: "tick" };

type Mode = "classic" | "levels";

type StreakState = {
  authenticated: boolean;
  canCheckIn: boolean;
  checkedInToday: boolean;
  expiresAt: string | null;
  isAdmin?: boolean;
  nextCheckInAt: string | null;
  streak: number;
};

const START_LENGTH = 1;
// The arcade contract takes cells as uint16 (capped at 4096) and moves as
// uint32. Clamping keeps a long run from reverting on save.
const MAX_ONCHAIN_CELLS = 4096;
const MAX_ONCHAIN_MOVES = 4_294_967_295;

// Prices are wei; this is only for showing them. Trailing zeros make a price
// unreadable at a glance, and six decimals is more than enough on Base.
function formatEth(value: bigint | null) {
  if (value === null) {
    return "…";
  }

  const eth = Number(formatEther(value));

  return `${eth.toFixed(eth >= 0.01 ? 3 : 6).replace(/0+$/, "").replace(/\.$/, "")} ETH`;
}

function formatUsd(cents: number | null) {
  return cents === null ? "…" : `$${(cents / 100).toFixed(2)}`;
}

// A quote is a block or two old by the time the transaction lands, and ETH
// moves. Sending a little over covers that; the contract refunds the rest, so
// the player is still charged exactly the dollar price.
function withQuoteBuffer(value: bigint) {
  return (value * 102n) / 100n;
}
const STEP_MS = 236;
const BEST_RUN_STORAGE_KEY = "snake.bestRunCells";
const DEFAULT_RECORD_CONTRACT_ADDRESS = "0x9e5d82E6B6419C066Bc57F5a70116659c468d780" as const;
const DEFAULT_BUILDER_CODE_SUFFIX =
  "0x62635f38776576327439680b0080218021802180218021802180218021" as const;
const RECORD_CONTRACT_ADDRESS =
  getAddressEnv(import.meta.env.VITE_RECORD_CONTRACT_ADDRESS) ?? DEFAULT_RECORD_CONTRACT_ADDRESS;
// Paymaster runs through our backend proxy so the CDP API key stays
// server-side. Backend env var is CDP_PAYMASTER_URL (or PAYMASTER_URL).
const PAYMASTER_URL = `${API_URL}/api/paymaster`;
const BUILDER_CODE_SUFFIX =
  getHexEnv(import.meta.env.VITE_BUILDER_CODE_SUFFIX) ?? DEFAULT_BUILDER_CODE_SUFFIX;

const vectors: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

const directionList: Direction[] = ["up", "right", "down", "left"];

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

function makeInitialSnake(cols: number, rows: number): Point[] {
  return [{ x: Math.floor(cols / 2), y: Math.floor(rows / 2) }];
}

function pointKey(point: Point) {
  return `${point.x},${point.y}`;
}

function getFood(snake: Point[], cols: number, rows: number): Point | null {
  // A set, not an inner some(): the largest level is 1024 cells and this runs
  // every time the snake eats.
  const taken = new Set(snake.map(pointKey));
  const freeCells: Point[] = [];

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (!taken.has(`${x},${y}`)) {
        freeCells.push({ x, y });
      }
    }
  }

  if (freeCells.length === 0) {
    return null;
  }

  return freeCells[Math.floor(Math.random() * freeCells.length)];
}

function isFoodValid(food: Point | null, snake: Point[], cols: number, rows: number) {
  return Boolean(
    food &&
      food.x >= 0 &&
      food.y >= 0 &&
      food.x < cols &&
      food.y < rows &&
      !snake.some((part) => samePoint(part, food))
  );
}

function createGame(board: BoardConfig = CLASSIC_BOARD, status: GameStatus = "idle"): GameState {
  const snake = makeInitialSnake(board.cols, board.rows);

  return {
    snake,
    food: getFood(snake, board.cols, board.rows),
    direction: "right",
    queuedDirection: "right",
    score: 0,
    moves: 0,
    status,
    cols: board.cols,
    rows: board.rows,
    goal: board.goal
  };
}

function boardOf(state: GameState): BoardConfig {
  return { cols: state.cols, rows: state.rows, goal: state.goal };
}

function directionBetween(from: Point, to: Point): Direction | null {
  if (to.x === from.x + 1 && to.y === from.y) return "right";
  if (to.x === from.x - 1 && to.y === from.y) return "left";
  if (to.y === from.y + 1 && to.x === from.x) return "down";
  if (to.y === from.y - 1 && to.x === from.x) return "up";
  return null;
}

// Every free cell you can actually reach from `start`, walking around the body.
// One open cell next to the head means nothing — it can be the mouth of a
// pocket two cells deep — so the revive is judged on reachable room, not on
// whether the first step is legal.
function reachableFrom(state: GameState, start: Point, blocked: Set<string>) {
  const room = new Set<string>();
  const inBounds = (cell: Point) =>
    cell.x >= 0 && cell.y >= 0 && cell.x < state.cols && cell.y < state.rows;

  if (!inBounds(start) || blocked.has(pointKey(start))) {
    return room;
  }

  const queue: Point[] = [start];
  room.add(pointKey(start));

  while (queue.length > 0) {
    const cell = queue.shift() as Point;

    for (const direction of directionList) {
      const vector = vectors[direction];
      const next = { x: cell.x + vector.x, y: cell.y + vector.y };
      const key = pointKey(next);

      if (inBounds(next) && !blocked.has(key) && !room.has(key)) {
        room.add(key);
        queue.push(next);
      }
    }
  }

  return room;
}

// The roomiest legal first step, with the space it opens onto.
function bestEscape(state: GameState) {
  const head = state.snake[0];
  // The tail cell empties as the snake moves, so it doesn't block.
  const blocked = new Set(state.snake.slice(0, -1).map(pointKey));
  let best: { direction: Direction; room: Set<string> } | null = null;

  for (const direction of directionList) {
    if (state.snake.length > 1 && isOpposite(state.direction, direction)) {
      continue;
    }

    const vector = vectors[direction];
    const room = reachableFrom(state, { x: head.x + vector.x, y: head.y + vector.y }, blocked);

    if (room.size > 0 && (!best || room.size > best.room.size)) {
      best = { direction, room };
    }
  }

  return best;
}

// How much space makes a revive worth a dollar. Never more than the board has
// left, so a nearly full board doesn't demand the impossible.
function requiredRoom(state: GameState) {
  const free = state.cols * state.rows - state.snake.length;

  return Math.min(Math.max(8, Math.ceil(state.snake.length / 2)), Math.max(1, free));
}

function reverseSnake(state: GameState): GameState {
  const snake = [...state.snake].reverse();

  return {
    ...state,
    snake,
    direction:
      snake.length > 1 ? directionBetween(snake[1], snake[0]) ?? state.direction : state.direction
  };
}

// Food inside a pocket the snake can't reach is the same as no food: the run
// can move but never score. Keep it if it's in the open space, move it if not.
function placeFoodInRoom(state: GameState, room: Set<string>): GameState {
  if (state.food && room.has(pointKey(state.food))) {
    return state;
  }

  const body = new Set(state.snake.map(pointKey));
  const candidates = Array.from(room).filter((key) => !body.has(key));

  if (candidates.length === 0) {
    return state;
  }

  const [x, y] = candidates[Math.floor(Math.random() * candidates.length)].split(",");

  return { ...state, food: { x: Number(x), y: Number(y) } };
}

// A revive is worthless if it hands back a run that can only crash again —
// dying into a corner is exactly when people pay. In order: leave the way the
// head can go, else swap head and tail (free, keeps the length), else give up
// length from the tail until real space opens. Score and moves are never
// touched, and the food is moved into whatever space the snake ends up in.
function makePlayableAfterRevive(state: GameState): GameState {
  const reversed = reverseSnake(state);
  let trimmed = reversed.snake;
  let roomiest: GameState | null = null;
  let roomiestSize = -1;

  // The head as it stands, then turned around, then shorter and shorter.
  const attempt = (candidate: GameState): GameState | null => {
    const escape = bestEscape(candidate);

    if (!escape) {
      return null;
    }

    const revived = placeFoodInRoom(
      { ...candidate, direction: escape.direction, queuedDirection: escape.direction },
      escape.room
    );

    if (escape.room.size > roomiestSize) {
      roomiest = revived;
      roomiestSize = escape.room.size;
    }

    return escape.room.size >= requiredRoom(candidate) ? revived : null;
  };

  const asIs = attempt(state);

  if (asIs) {
    return asIs;
  }

  const turnedAround = attempt(reversed);

  if (turnedAround) {
    return turnedAround;
  }

  while (trimmed.length > 1) {
    trimmed = trimmed.slice(0, -1);

    const shorter = attempt({ ...reversed, snake: trimmed });

    if (shorter) {
      return shorter;
    }
  }

  // Nothing cleared the bar — hand back the roomiest option found, which on a
  // board this full is the best there is.
  return roomiest ?? state;
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

function getAddressEnv(value: string | undefined): Address | null {
  return value && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value as Address) : null;
}

function getHexEnv(value: string | undefined): Hex | null {
  return value && /^0x([a-fA-F0-9]{2})+$/.test(value) ? (value as Hex) : null;
}

// dataSuffix is NOT a standard EIP-5792 capability — wallets ignore it.
// For sendCalls we append BUILDER_CODE_SUFFIX manually to call data.
const TRANSACTION_CAPABILITIES = PAYMASTER_URL
  ? { paymasterService: { url: PAYMASTER_URL } }
  : {};

function withBuilderSuffix(data: Hex): Hex {
  return `${data}${BUILDER_CODE_SUFFIX.slice(2)}` as Hex;
}

// A sent transaction, before anyone knows whether it landed. `reference` is a
// bundle id for batched calls and a tx hash otherwise — they are not
// interchangeable, so the kind travels with the value.
type SentTransaction = {
  kind: "calls" | "transaction";
  reference: string;
};

// The wallet only tells us the call was accepted. Sponsorship can still be
// refused and the call can still revert, so wait for a final status before
// telling the player anything was saved. The hash travels back with it: the
// backend stores a run only against the transaction that recorded it, and a
// batched call's bundle id is not something it can look up.
type ConfirmedTransaction = {
  hash: Hex | null;
  ok: boolean;
};

async function confirmTransaction(sent: SentTransaction): Promise<ConfirmedTransaction> {
  if (sent.kind === "calls") {
    const result = await waitForCallsStatus(wagmiConfig, { id: sent.reference });

    return {
      hash: result.receipts?.[0]?.transactionHash ?? null,
      ok: result.status === "success"
    };
  }

  const receipt = await waitForTransactionReceipt(wagmiConfig, {
    hash: sent.reference as Hex
  });

  return { hash: receipt.transactionHash, ok: receipt.status === "success" };
}

// A run is only in the database if a transaction put it there: the backend
// reads mode, level and score out of the event, so this sends nothing but the
// hash. A freshly mined transaction can be ahead of the backend's RPC, which
// answers 409 — worth waiting out, unlike any other failure.
async function persistRun(txHash: Hex) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${API_URL}/api/runs`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ txHash })
    });

    if (response.ok) {
      return true;
    }

    if (response.status !== 409) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return false;
}

// Sponsorship is best-effort: if the paymaster is unconfigured or out of
// budget, fall back to a self-paid transaction instead of dead-ending. A
// wallet rejection is the user's decision and must not be retried.
function isSponsorshipError(caught: unknown) {
  if (!(caught instanceof Error)) {
    return false;
  }

  const message = caught.message.toLowerCase();

  if (message.includes("rejected") || message.includes("denied") || message.includes("cancel")) {
    return false;
  }

  return message.includes("paymaster") || message.includes("sponsor");
}

type WalletCapabilities = {
  atomic?: {
    status?: string;
  };
};

function getBaseCapabilities(capabilities: unknown): WalletCapabilities | undefined {
  if (!capabilities || typeof capabilities !== "object") {
    return undefined;
  }

  const directCapabilities = capabilities as WalletCapabilities;
  const byChain = capabilities as Record<number, WalletCapabilities | undefined>;

  return byChain[base.id] ?? directCapabilities;
}

function supportsBatching(capabilities: WalletCapabilities | undefined) {
  return capabilities?.atomic?.status === "ready" || capabilities?.atomic?.status === "supported";
}

function ensureFoodOnState(state: GameState): GameState {
  if (
    state.status === "won" ||
    state.snake.length >= state.cols * state.rows ||
    isFoodValid(state.food, state.snake, state.cols, state.rows)
  ) {
    return state;
  }

  return { ...state, food: getFood(state.snake, state.cols, state.rows) };
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
  const currentFood = isFoodValid(cleanState.food, cleanState.snake, cleanState.cols, cleanState.rows)
    ? cleanState.food
    : getFood(cleanState.snake, cleanState.cols, cleanState.rows);
  const head = cleanState.snake[0];
  const vector = vectors[direction];
  const nextHead = { x: head.x + vector.x, y: head.y + vector.y };
  const outOfBounds =
    nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= cleanState.cols || nextHead.y >= cleanState.rows;
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
  // Classic keeps the fill-the-board rule (goal === every cell); a level is
  // cleared at its quota.
  const won = nextSnake.length >= cleanState.goal;
  const moves = cleanState.moves + 1;

  return {
    ...cleanState,
    snake: nextSnake,
    food: won ? null : eating || !currentFood ? getFood(nextSnake, cleanState.cols, cleanState.rows) : currentFood,
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
        return createGame(boardOf(state), "running");
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
      return createGame(boardOf(state), "idle");

    case "loadBoard":
      return createGame(action.board, action.start ? "running" : "idle");

    // Pressing an arrow while the board is standing still both starts the run
    // and turns: after a revive there is no time to hit play and then a key.
    case "startWithDirection": {
      if (state.status === "paused") {
        // A snake can't reverse into its own neck. Starting in some *other*
        // direction instead is worse than not starting: the player presses
        // down, the snake leaves in the direction it was already facing, and
        // the revive they just paid for is spent on a move they never asked
        // for. So an impossible key simply doesn't start the run.
        if (state.snake.length > 1 && isOpposite(state.direction, action.direction)) {
          return state;
        }

        return {
          ...state,
          status: "running",
          direction: action.direction,
          queuedDirection: action.direction
        };
      }

      if (state.status === "idle") {
        return {
          ...createGame(boardOf(state), "running"),
          direction: action.direction,
          queuedDirection: action.direction
        };
      }

      return state;
    }

    // A revive resumes the run that just ended: same snake, same score, same
    // move count — only the direction is nudged somewhere survivable, and the
    // game waits paused so the player isn't dropped straight back into motion.
    case "revive": {
      if (state.status !== "lost") {
        return state;
      }

      return ensureFoodOnState({ ...makePlayableAfterRevive(state), status: "paused" });
    }

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

function Game() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const mode: Mode = searchParams.get("mode") === "levels" ? "levels" : "classic";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const coinImageRef = useRef<HTMLImageElement | null>(null);
  const animationFrameRef = useRef(0);
  const accumulatorRef = useRef(0);
  const gameRef = useRef<GameState>(createGame());
  const lastFrameAtRef = useRef(0);
  const stepStartedAtRef = useRef(0);
  const targetSnakeRef = useRef<Point[]>(gameRef.current.snake);
  const previousSnakeRef = useRef<Point[]>(gameRef.current.snake);
  const isMountedRef = useRef(true);
  // Re-arm on mount: with only the cleanup, a remount (StrictMode in dev) left
  // the flag false forever and every post-await setState was skipped.
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const [levelIndex, setLevelIndex] = useState(getLevelProgress);
  const [game, dispatch] = useReducer(reducer, undefined, () =>
    createGame(searchParams.get("mode") === "levels" ? getLevel(getLevelProgress()) : CLASSIC_BOARD)
  );
  const [isShopOpen, setIsShopOpen] = useState(false);
  const [packQuantity, setPackQuantity] = useState(1);
  const [isBuying, setIsBuying] = useState(false);
  const [purchaseStatus, setPurchaseStatus] = useState<string | null>(null);
  const [levelBest, setLevelBest] = useState(() =>
    getLevelBest(searchParams.get("mode") === "levels" ? getLevelProgress() : 0)
  );
  const revives = useRevives();
  const [activeDirection, setActiveDirection] = useState<Direction | null>(null);
  const [coinReady, setCoinReady] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [recordStatus, setRecordStatus] = useState<string | null>(null);
  const [recordSaved, setRecordSaved] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [streak, setStreak] = useState<StreakState | null>(null);
  const [isCheckingIn, setIsCheckingIn] = useState(false);
  const [streakStatus, setStreakStatus] = useState<string | null>(null);
  const [isSendingNotification, setIsSendingNotification] = useState(false);
  const [notifyToast, setNotifyToast] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(() => getStoredIsAdmin());
  const [bestRunCells, setBestRunCells] = useState(() => getStoredBestRunCells());
  const { address, connector, isConnected } = useAccount();
  const { sendCallsAsync, isPending: isSavingRecord } = useSendCalls();
  const { writeContractAsync, isPending: isWritingContract } = useWriteContract();
  const { data: walletCapabilities } = useCapabilities({
    chainId: base.id,
    query: {
      enabled: Boolean(address && connector)
    }
  });
  const { switchChainAsync } = useSwitchChain();
  // Prices are dollars in the contract; what to send is a quote it computes
  // from the ETH/USD feed. So both are read: the cents for the label, the wei
  // for the transaction. Quotes go stale as ETH moves, hence the refetch.
  const { data: arcadeConfig } = useReadContracts({
    contracts: [
      { address: ARCADE_ADDRESS ?? undefined, abi: snakeArcadeAbi, functionName: "quoteRecord", chainId: base.id },
      { address: ARCADE_ADDRESS ?? undefined, abi: snakeArcadeAbi, functionName: "quoteSingleRevive", chainId: base.id },
      { address: ARCADE_ADDRESS ?? undefined, abi: snakeArcadeAbi, functionName: "quotePacks", args: [1], chainId: base.id },
      { address: ARCADE_ADDRESS ?? undefined, abi: snakeArcadeAbi, functionName: "packRevives", chainId: base.id },
      { address: ARCADE_ADDRESS ?? undefined, abi: snakeArcadeAbi, functionName: "recordPriceCents", chainId: base.id },
      { address: ARCADE_ADDRESS ?? undefined, abi: snakeArcadeAbi, functionName: "singleRevivePriceCents", chainId: base.id },
      { address: ARCADE_ADDRESS ?? undefined, abi: snakeArcadeAbi, functionName: "packRevivePriceCents", chainId: base.id }
    ],
    query: { enabled: Boolean(ARCADE_ADDRESS), refetchInterval: 60_000 }
  });

  const recordPrice = (arcadeConfig?.[0]?.result as bigint | undefined) ?? null;
  const singleRevivePrice = (arcadeConfig?.[1]?.result as bigint | undefined) ?? null;
  const packRevivePrice = (arcadeConfig?.[2]?.result as bigint | undefined) ?? null;
  const packRevives = (arcadeConfig?.[3]?.result as number | undefined) ?? SANDBOX_PACK_REVIVES;
  const recordPriceCents = (arcadeConfig?.[4]?.result as number | undefined) ?? null;
  const singleRevivePriceCents = (arcadeConfig?.[5]?.result as number | undefined) ?? null;
  const packRevivePriceCents = (arcadeConfig?.[6]?.result as number | undefined) ?? null;

  const totalCells = game.cols * game.rows;
  const targetBoard = mode === "levels" ? getLevel(levelIndex) : CLASSIC_BOARD;
  const isLastLevel = levelIndex >= LAST_LEVEL_INDEX;
  const filledPercent = Math.min(100, Math.round((game.snake.length / game.goal) * 100));
  const gameEnded = game.status === "lost" || game.status === "won";
  const currentRunCells = Math.max(0, game.snake.length - START_LENGTH);
  const shownBestRunCells = Math.max(bestRunCells, currentRunCells);
  const isOnchainPending = isSavingRecord || isWritingContract || isConfirming;
  const shouldUseBatchCalls = supportsBatching(getBaseCapabilities(walletCapabilities));
  const streakUi = getStreakUi(streak, nowMs);
  const canCheckIn = Boolean(streak?.canCheckIn && address && !isCheckingIn && !isOnchainPending);

  // A fresh run is starting — clear any save status left from the previous one.
  // Covers every way back into "running" (Play Again, Space-to-restart, R reset+replay),
  // not just the Play Again button.
  useEffect(() => {
    if (game.status === "running") {
      setRecordStatus(null);
      setRecordSaved(false);
    }
  }, [game.status]);

  // The route keeps this component mounted when the mode changes, so the board
  // is synced here rather than at mount. Comparing first keeps a board that was
  // just loaded on purpose (next level) from being reset right back to idle.
  useEffect(() => {
    if (
      game.cols === targetBoard.cols &&
      game.rows === targetBoard.rows &&
      game.goal === targetBoard.goal
    ) {
      return;
    }

    dispatch({ type: "loadBoard", board: targetBoard });
  }, [targetBoard.cols, targetBoard.rows, targetBoard.goal, game.cols, game.rows, game.goal]);

  // Clearing a level unlocks the next one.
  useEffect(() => {
    if (mode !== "levels" || game.status !== "won") {
      return;
    }

    const unlocked = clampLevel(levelIndex + 1);

    if (unlocked > getLevelProgress()) {
      storeLevelProgress(unlocked);
    }
  }, [game.status, levelIndex, mode]);

  useEffect(() => {
    setLevelBest(getLevelBest(levelIndex));
  }, [levelIndex]);

  // Every finished run in level mode leaves its score against its level, so a
  // saved record can name both.
  useEffect(() => {
    if (mode !== "levels" || (game.status !== "lost" && game.status !== "won")) {
      return;
    }

    setLevelBest(storeLevelBest(levelIndex, game.score));
  }, [game.status, game.score, levelIndex, mode]);

  // Crashing costs the ladder: the next run starts at level 1. Stored right at
  // the crash so closing the app mid-death screen doesn't dodge it, but the
  // level in state is left alone — a revive continues the run that's still open.
  useEffect(() => {
    if (mode !== "levels" || game.status !== "lost") {
      return;
    }

    storeLevelProgress(0);
  }, [game.status, mode]);

  const queueDirection = (direction: Direction) => {
    const liveGame = gameRef.current;
    const canTurn = liveGame.snake.length <= 1 || !isOpposite(liveGame.direction, direction);
    const isNewDirection = liveGame.queuedDirection !== direction;

    // Standing still: the arrow itself starts the run in that direction.
    if (liveGame.status === "paused" || liveGame.status === "idle") {
      accumulatorRef.current = 0;
      dispatch({ type: "startWithDirection", direction });
      return;
    }

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

  // Listen for auth-changed: WalletConnect attaches isAdmin in detail.
  useEffect(() => {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        setIsAdmin(getStoredIsAdmin());
        return;
      }
      const detail = event.detail as { isAdmin?: boolean } | null;
      if (typeof detail?.isAdmin === "boolean") {
        setIsAdmin(detail.isAdmin);
      } else {
        setIsAdmin(getStoredIsAdmin());
      }
    };
    window.addEventListener("snake:auth-changed", handler);
    return () => window.removeEventListener("snake:auth-changed", handler);
  }, []);

  useEffect(() => {
    if (!isConnected || !address) {
      setStreak(null);
      return;
    }

    // Show last cached streak immediately so the timer/cooldown is visible
    // before the network round-trip (especially on Render free-tier cold starts).
    const cached = readCachedStreak(address);
    if (cached) setStreak(cached);

    let cancelled = false;
    const loadStreak = async () => {
      try {
        const response = await fetch(`${API_URL}/api/streak`, {
          credentials: "include",
          headers: authHeaders()
        });
        if (cancelled) return;

        if (!response.ok) {
          // 401 = not authenticated yet (auto-SIWE in flight). Keep cached value
          // and re-run on the snake:auth-changed event below.
          if (response.status !== 401) setStreak(null);
          return;
        }

        const json: unknown = await response.json();
        if (cancelled) return;
        if (!isStreakState(json)) return;
        setStreak(json);
        writeCachedStreak(address, json);
      } catch {
        if (cancelled) return;
        // Keep cached value on network error
      }
    };

    void loadStreak();

    // Refetch after WalletConnect completes SIWE so cooldown timer is fresh.
    const handler = () => void loadStreak();
    window.addEventListener("snake:auth-changed", handler);

    return () => {
      cancelled = true;
      window.removeEventListener("snake:auth-changed", handler);
    };
  }, [address, isConnected]);

  useEffect(() => {
    if (
      game.status !== "won" &&
      game.snake.length < totalCells &&
      !isFoodValid(game.food, game.snake, game.cols, game.rows)
    ) {
      dispatch({ type: "ensureFood" });
    }
  }, [game.food, game.snake, game.status, game.cols, game.rows, totalCells]);

  useEffect(() => {
    if (!gameEnded) {
      return;
    }

    setBestRunCells((best) => {
      const nextBest = Math.max(best, currentRunCells);
      storeBestRunCells(nextBest);
      return nextBest;
    });
  }, [currentRunCells, gameEnded]);

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

      // The shop sits over the board: keys belong to the dialog while it's open,
      // otherwise a mistyped key restarts the run behind it.
      if (isShopOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsShopOpen(false);
        }

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
  }, [game.status, isShopOpen]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    // Logical width is fixed; height follows the board so a 32×16 level draws
    // square cells instead of stretched ones. The panel matches via aspect-ratio.
    const logicalWidth = 720;
    const drawFrame = (now: number) => {
      const devicePixelRatio = window.devicePixelRatio || 1;
      const lastFrameAt = lastFrameAtRef.current || now;
      const delta = Math.min(80, now - lastFrameAt);
      const liveGame = gameRef.current;
      const logicalHeight = Math.round((logicalWidth * liveGame.rows) / liveGame.cols);

      lastFrameAtRef.current = now;
      if (
        canvas.width !== logicalWidth * devicePixelRatio ||
        canvas.height !== logicalHeight * devicePixelRatio
      ) {
        canvas.width = logicalWidth * devicePixelRatio;
        canvas.height = logicalHeight * devicePixelRatio;
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

      drawGame(context, logicalWidth, logicalHeight, renderGame, coinReady ? coinImageRef.current : null);

      animationFrameRef.current = requestAnimationFrame(drawFrame);
    };

    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = requestAnimationFrame(drawFrame);

    return () => cancelAnimationFrame(animationFrameRef.current);
  }, [coinReady]);

  const statusText = useMemo(() => {
    if (game.status === "won") {
      if (mode === "levels") {
        return isLastLevel ? "All levels clear" : "Level clear";
      }

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
  }, [game.status, isLastLevel, mode]);

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

  const playAgain = () => {
    // Starting over after a crash in level mode means starting over from the
    // first board, not retrying the one that killed you.
    if (mode === "levels" && game.status === "lost" && levelIndex > 0) {
      setLevelIndex(0);
      dispatch({ type: "loadBoard", board: getLevel(0), start: true });
      releaseFocus();
      return;
    }

    dispatch({ type: "start" });
    releaseFocus();
  };

  // No balance means the shop, not a dead end: buying while dead revives on the
  // spot, which is the whole point of the $1 tier.
  // With nothing in stock this buys the single revive — the one sold only here,
  // at the crash — and spends it in the same press.
  const useRevive = async () => {
    if (isBuying) {
      return;
    }

    setPurchaseStatus(null);
    setIsBuying(true);

    try {
      if (revives <= 0) {
        if (PAYMENTS_ARE_LIVE) {
          setPurchaseStatus("Confirming payment...");

          const sent = await sendBuyRevivesTransaction(null);
          const confirmed = await confirmTransaction(sent);

          if (!confirmed.ok) {
            throw new Error("Payment failed onchain");
          }

          await refreshRevives();
        } else {
          creditSandboxRevives(1);
        }
      }

      if (!(await spendRevive())) {
        throw new Error("No revives available");
      }

      setPurchaseStatus(null);
      dispatch({ type: "revive" });
    } catch (caught) {
      setPurchaseStatus(caught instanceof Error ? caught.message : "Purchase failed");
    } finally {
      if (isMountedRef.current) {
        setIsBuying(false);
      }

      releaseFocus();
    }
  };

  const buyPacks = async () => {
    if (isBuying) {
      return;
    }

    setPurchaseStatus(null);
    setIsBuying(true);

    try {
      if (PAYMENTS_ARE_LIVE) {
        setPurchaseStatus("Confirming payment...");

        const sent = await sendBuyRevivesTransaction(packQuantity);
        const confirmed = await confirmTransaction(sent);

        if (!confirmed.ok) {
          throw new Error("Payment failed onchain");
        }

        await refreshRevives();
      } else {
        creditSandboxRevives(SANDBOX_PACK_REVIVES * packQuantity);
      }

      setIsShopOpen(false);
      setPackQuantity(1);
      setPurchaseStatus(null);

      // Bought mid-death: spend one straight away, which is what the player
      // opened the shop for.
      if (gameRef.current.status === "lost" && (await spendRevive())) {
        dispatch({ type: "revive" });
      }
    } catch (caught) {
      setPurchaseStatus(caught instanceof Error ? caught.message : "Purchase failed");
    } finally {
      if (isMountedRef.current) {
        setIsBuying(false);
      }

      releaseFocus();
    }
  };

  const goToNextLevel = () => {
    const next = clampLevel(levelIndex + 1);

    setLevelIndex(next);
    dispatch({ type: "loadBoard", board: getLevel(next), start: true });
    releaseFocus();
  };


  const exitGame = () => {
    setRecordStatus(null);
    dispatch({ type: "reset" });
    navigate("/");
    releaseFocus();
  };

  const sendBatchedCall = async (to: Address, data: Hex, value = 0n): Promise<SentTransaction> => {
    const calls = [{ data, to, value }];

    try {
      const result = await sendCallsAsync({
        calls,
        capabilities: TRANSACTION_CAPABILITIES,
        chainId: base.id
      });

      return { kind: "calls", reference: result.id };
    } catch (caught) {
      if (!isSponsorshipError(caught)) {
        throw caught;
      }

      console.warn("Sponsorship unavailable, sending self-paid call", caught);
      const result = await sendCallsAsync({ calls, chainId: base.id });

      return { kind: "calls", reference: result.id };
    }
  };

  const sendCheckInTransaction = async (): Promise<SentTransaction> => {
    if (!address) {
      throw new Error("Connect wallet first");
    }

    await switchChainAsync({ chainId: base.id });

    if (shouldUseBatchCalls) {
      return sendBatchedCall(
        RECORD_CONTRACT_ADDRESS,
        withBuilderSuffix(encodeFunctionData({ abi: snakeRecordsAbi, functionName: "checkIn" }))
      );
    }

    const hash = await writeContractAsync({
      address: RECORD_CONTRACT_ADDRESS,
      abi: snakeRecordsAbi,
      functionName: "checkIn",
      chainId: base.id,
      dataSuffix: BUILDER_CODE_SUFFIX
    });

    return { kind: "transaction", reference: hash };
  };

  // Saving carries the mode and the level, and costs the same in both modes.
  // Classic always records at level 0, which is what keeps a classic score from
  // ever landing on top of a level record.
  const sendRecordRunTransaction = async (): Promise<SentTransaction> => {
    if (!ARCADE_ADDRESS) {
      throw new Error("Set VITE_ARCADE_CONTRACT_ADDRESS after deploy");
    }

    if (!address) {
      throw new Error("Connect wallet first");
    }

    if (recordPrice === null) {
      throw new Error("Could not read the save price from the contract");
    }

    const value = withQuoteBuffer(recordPrice);

    const args = [
      mode === "levels" ? MODE_LEVELS : MODE_CLASSIC,
      mode === "levels" ? levelIndex + 1 : 0,
      BigInt(game.score),
      Math.min(game.snake.length, MAX_ONCHAIN_CELLS),
      Math.min(game.moves, MAX_ONCHAIN_MOVES),
      game.status === "won"
    ] as const;

    await switchChainAsync({ chainId: base.id });

    if (shouldUseBatchCalls) {
      return sendBatchedCall(
        ARCADE_ADDRESS,
        withBuilderSuffix(encodeFunctionData({ abi: snakeArcadeAbi, functionName: "recordRun", args })),
        value
      );
    }

    const hash = await writeContractAsync({
      address: ARCADE_ADDRESS,
      abi: snakeArcadeAbi,
      functionName: "recordRun",
      args,
      value,
      chainId: base.id,
      dataSuffix: BUILDER_CODE_SUFFIX
    });

    return { kind: "transaction", reference: hash };
  };

  // packs === null buys the single revive sold on the death screen.
  const sendBuyRevivesTransaction = async (packs: number | null): Promise<SentTransaction> => {
    if (!ARCADE_ADDRESS) {
      throw new Error("Set VITE_ARCADE_CONTRACT_ADDRESS after deploy");
    }

    if (!address) {
      throw new Error("Connect wallet first");
    }

    const price = packs === null ? singleRevivePrice : packRevivePrice;

    if (price === null) {
      throw new Error("Could not read the price from the contract");
    }

    const value = withQuoteBuffer(packs === null ? price : price * BigInt(packs));

    await switchChainAsync({ chainId: base.id });

    const data =
      packs === null
        ? encodeFunctionData({ abi: snakeArcadeAbi, functionName: "buySingleRevive" })
        : encodeFunctionData({
            abi: snakeArcadeAbi,
            functionName: "buyRevivePacks",
            args: [packs] as const
          });

    if (shouldUseBatchCalls) {
      return sendBatchedCall(ARCADE_ADDRESS, withBuilderSuffix(data), value);
    }

    const hash =
      packs === null
        ? await writeContractAsync({
            address: ARCADE_ADDRESS,
            abi: snakeArcadeAbi,
            functionName: "buySingleRevive",
            value,
            chainId: base.id,
            dataSuffix: BUILDER_CODE_SUFFIX
          })
        : await writeContractAsync({
            address: ARCADE_ADDRESS,
            abi: snakeArcadeAbi,
            functionName: "buyRevivePacks",
            args: [packs] as const,
            value,
            chainId: base.id,
            dataSuffix: BUILDER_CODE_SUFFIX
          });

    return { kind: "transaction", reference: hash };
  };

  const checkIn = async () => {
    setStreakStatus(null);
    setIsCheckingIn(true);

    try {
      // Check the session before spending a transaction. The old order sent the
      // wallet call first and only then discovered the backend answers 401.
      const session = await fetch(`${API_URL}/api/auth/me`, {
        credentials: "include",
        headers: authHeaders()
      });

      if (!session.ok) {
        throw new Error("Sign in with your wallet first");
      }

      if (RECORD_CONTRACT_ADDRESS && (!streak || streak.canCheckIn)) {
        const sent = await sendCheckInTransaction();

        setStreakStatus("Confirming...");

        // Unknown (timeout) is treated as landed: the call is already
        // broadcast, and skipping the backend would drift the two streaks
        // apart. Only a known failure stops us.
        let confirmed = true;

        try {
          confirmed = (await confirmTransaction(sent)).ok;
        } catch (caught) {
          console.warn("Could not confirm check-in", caught);
        }

        if (!confirmed) {
          throw new Error("Check-in transaction failed onchain");
        }
      }

      const response = await fetch(`${API_URL}/api/streak/check-in`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders()
      });
      const json: unknown = await response.json().catch(() => null);
      const data = isStreakState(json) ? (json as StreakState & { error?: string }) : null;

      if (!response.ok || !data) {
        const rawError = (json as { error?: unknown } | null)?.error;
        throw new Error(typeof rawError === "string" ? rawError : "Check-in failed");
      }

      setStreak(data);
      if (address) writeCachedStreak(address, data);
      setStreakStatus(data.checkedInToday ? "Checked in" : "Already active");
    } catch (caught) {
      setStreakStatus(caught instanceof Error ? caught.message : "Check-in failed");
    } finally {
      if (isMountedRef.current) setIsCheckingIn(false);
    }
  };

  const sendAdminNotification = async () => {
    if (isSendingNotification) return;
    setNotifyToast(null);
    setIsSendingNotification(true);

    try {
      const response = await fetch(`${API_URL}/api/admin/notify-random`, {
        method: "POST",
        credentials: "include",
        headers: authHeaders()
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        sentCount?: number;
        failedCount?: number;
        audienceCount?: number;
      } | null;

      if (!response.ok) {
        throw new Error(data?.error ?? "Notification failed");
      }

      const sent = data?.sentCount ?? 0;
      const audience = data?.audienceCount ?? sent;
      setNotifyToast(sent > 0 ? `Sent to ${sent}/${audience} players` : "No subscribers — enable in Base App");
      setStreakStatus(`Sent ${sent}`);
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : "Notification failed";
      setNotifyToast(msg);
      setStreakStatus(msg);
    } finally {
      setIsSendingNotification(false);
      window.setTimeout(() => setNotifyToast(null), 2800);
    }
  };

  const saveRecord = async () => {
    if (!gameEnded) {
      return;
    }

    if (!ARCADE_ADDRESS) {
      setRecordStatus("Set VITE_ARCADE_CONTRACT_ADDRESS after deploy");
      return;
    }

    setRecordStatus(null);

    try {
      if (!address || !connector) {
        throw new Error("Connect wallet first");
      }

      const sent = await sendRecordRunTransaction();
      if (!isMountedRef.current) return;

      setRecordStatus(`Sent ${sent.reference.slice(0, 10)}... confirming`);
      setIsConfirming(true);

      // null = we stopped waiting, not that it failed.
      let confirmed: ConfirmedTransaction | null = { hash: null, ok: true };

      try {
        confirmed = await confirmTransaction(sent);
      } catch (caught) {
        console.warn("Could not confirm record run", caught);
        confirmed = null;
      }

      if (!isMountedRef.current) return;

      if (confirmed && !confirmed.ok) {
        setRecordStatus("Transaction failed onchain");
        return;
      }

      setRecordSaved(true);
      // Name what was saved: on the ladder a bare number says nothing about
      // which board earned it.
      const runLabel =
        mode === "levels"
          ? `level ${levelIndex + 1}, score ${game.score}`
          : `score ${game.score}`;
      setRecordStatus(
        confirmed ? `Saved onchain — ${runLabel}` : `Sent — ${runLabel}, confirmation pending`
      );

      // The database only ever learns about a run through its transaction.
      if (confirmed?.hash) {
        const stored = await persistRun(confirmed.hash);

        if (isMountedRef.current && !stored) {
          setRecordStatus(`Saved onchain — ${runLabel} (leaderboard sync pending)`);
        }
      }
    } catch (caught) {
      if (isMountedRef.current) {
        setRecordStatus(caught instanceof Error ? caught.message : "Record transaction failed");
      }
    } finally {
      if (isMountedRef.current) setIsConfirming(false);
    }
  };

  return (
    <div className="gs-root">
      <div className="gs-grid-bg" />

      {/* Header */}
      <header className="gs-header">
        <div className="gs-header-left">
          <button
            className="gs-back-btn"
            type="button"
            onClick={exitGame}
            title="Back to menu"
            aria-label="Back to menu"
          >
            <ChevronLeft />
          </button>
          <div>
            <div className="gs-brand-label">
              <img src="/coin.png" alt="" className="gs-brand-icon" />
              Base Snake
            </div>
            <h1 className="gs-title">{statusText}</h1>
          </div>
        </div>
        <WalletConnect />
      </header>

      {/* Stats bar */}
      <div className="gs-stats-bar">
        <div className="gs-stats-left">
          {mode === "levels" && (
            <div className="gs-pill gs-pill-level">
              LVL {levelIndex + 1}
              <small>{game.cols}×{game.rows}</small>
            </div>
          )}
          <div className="gs-pill">{game.snake.length}/{game.goal}</div>
          {/* The level pill already takes the room the percentage used to have. */}
          {mode === "classic" && <div className="gs-pill">{filledPercent}%</div>}
          <button
            className="gs-revive-pill"
            type="button"
            onClick={() => setIsShopOpen(true)}
            title="Revives"
            aria-label={`Revives: ${revives}`}
          >
            <Heart size={13} />
            <strong>{revives}</strong>
            <Plus size={11} />
          </button>
        </div>
        <div className="gs-stats-right">
          {(isAdmin || streak?.isAdmin) && (
            <button
              className={`gs-bell-btn${isSendingNotification ? " is-loading" : ""}`}
              type="button"
              onClick={sendAdminNotification}
              disabled={isSendingNotification}
              title="Send random notification to all players"
              aria-label="Send notification"
            >
              <Bell size={16} />
            </button>
          )}
          <button
            className="gs-checkin-btn"
            type="button"
            onClick={checkIn}
            disabled={!canCheckIn}
            title={address ? "Check in" : "Connect wallet first"}
          >
            Check-in
          </button>
          <div className="gs-streak">
            <span>Streak</span>
            <strong>{streakUi.count}</strong>
            <span className="gs-streak-timer">{streakUi.timer}</span>
          </div>
        </div>
      </div>

      {notifyToast && (
        <div className="gs-toast" role="status" aria-live="polite">
          <Bell size={14} />
          <span>{notifyToast}</span>
        </div>
      )}

      {/* Game board */}
      <main className="gs-board-area">
        <div
          className="gs-board-panel"
          style={{ "--gs-board-aspect": game.cols / game.rows } as CSSProperties}
        >
          <canvas ref={canvasRef} aria-label="Snake board" />
          {game.status === "paused" && (
            <div className="gs-pause-marks" aria-hidden="true">
              <span /><span />
            </div>
          )}
          {game.status === "idle" && (
            <div className="gs-overlay" aria-live="polite">
              <strong>Press play</strong>
              <p>
                {mode === "levels"
                  ? `Reach ${game.goal} cells to clear level ${levelIndex + 1}.`
                  : "Fill the board to finish the game."}
              </p>
              {streakStatus && <small>{streakStatus}</small>}
            </div>
          )}
        </div>
      </main>

      {/* D-pad */}
      <div className="gs-controls">
        <div className="gs-dpad">
          {/* Row 1 */}
          <span />
          <button
            className="gs-dpad-btn"
            type="button"
            aria-label="Up"
            onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pressDirection("up"); }}
            onPointerLeave={() => releaseDirection("up")}
            onPointerUp={() => releaseDirection("up")}
          >
            <ChevronUp strokeWidth={2.5} />
          </button>
          <span />

          {/* Row 2 */}
          <button
            className="gs-dpad-btn"
            type="button"
            aria-label="Left"
            onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pressDirection("left"); }}
            onPointerLeave={() => releaseDirection("left")}
            onPointerUp={() => releaseDirection("left")}
          >
            <ChevronLeft strokeWidth={2.5} />
          </button>
          <button
            className="gs-dpad-center"
            type="button"
            aria-label={game.status === "running" ? "Pause" : "Start"}
            onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); dispatch({ type: game.status === "running" ? "pause" : "start" }); releaseFocus(); }}
          >
            {game.status === "running" ? <Pause /> : <Play />}
          </button>
          <button
            className="gs-dpad-btn"
            type="button"
            aria-label="Right"
            onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pressDirection("right"); }}
            onPointerLeave={() => releaseDirection("right")}
            onPointerUp={() => releaseDirection("right")}
          >
            <ChevronRight strokeWidth={2.5} />
          </button>

          {/* Row 3 */}
          {game.status === "paused" ? (
            <button
              className="gs-dpad-restart"
              type="button"
              aria-label="Restart"
              onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); dispatch({ type: "reset" }); releaseFocus(); }}
            >
              <RotateCcw />
            </button>
          ) : (
            <span />
          )}
          <button
            className="gs-dpad-btn"
            type="button"
            aria-label="Down"
            onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pressDirection("down"); }}
            onPointerLeave={() => releaseDirection("down")}
            onPointerUp={() => releaseDirection("down")}
          >
            <ChevronDown strokeWidth={2.5} />
          </button>
          <span />
        </div>
      </div>

      {gameEnded && (
        <section className="gs-end-screen" aria-live="polite">
          <div className="gs-end-content">
            <div className="gs-end-title-wrap">
              <div className="gs-end-red-glow" />
              <h2 className={game.status === "won" ? "gs-end-title gs-end-title-win" : "gs-end-title"}>
                {game.status !== "won" ? (
                  <>
                    GAME<br />OVER
                  </>
                ) : mode !== "levels" ? (
                  <>
                    SCREEN<br />FILLED
                  </>
                ) : isLastLevel ? (
                  <>
                    ALL LEVELS<br />CLEAR
                  </>
                ) : (
                  <>
                    LEVEL {levelIndex + 1}<br />CLEAR
                  </>
                )}
              </h2>
            </div>

            <div className="gs-end-score-grid">
              <div className="gs-end-score-card">
                <span>Current</span>
                <strong>{currentRunCells}</strong>
              </div>
              <div className="gs-end-score-card gs-end-score-card-best">
                <span>Best</span>
                <strong>{shownBestRunCells}</strong>
              </div>
            </div>

            {mode === "levels" && (
              <p className="gs-end-level-line">
                Level {levelIndex + 1} · {game.cols}×{game.rows} · score {game.score}
                {levelBest > game.score ? ` · best here ${levelBest}` : ""}
              </p>
            )}

            <div className="gs-end-actions">
              {game.status === "lost" && (
                <>
                  <button
                    className="gs-end-revive"
                    type="button"
                    onClick={() => void useRevive()}
                    disabled={isBuying}
                  >
                    <Heart />
                    <span>
                      {isBuying
                        ? "Paying..."
                        : revives > 0
                          ? `Revive · ${revives} left`
                          : `Revive · ${
                              PAYMENTS_ARE_LIVE ? formatUsd(singleRevivePriceCents) : "free (local)"
                            }`}
                    </span>
                  </button>
                  {PAYMENTS_ARE_LIVE && revives <= 0 && (
                    <small className="gs-end-local-note">
                      ≈ {formatEth(singleRevivePrice)} at the current rate
                    </small>
                  )}
                  <button
                    className="gs-end-shop-link"
                    type="button"
                    onClick={() => setIsShopOpen(true)}
                  >
                    or stock up · {packRevives} for{" "}
                    {PAYMENTS_ARE_LIVE ? formatUsd(packRevivePriceCents) : "free (local)"}
                  </button>
                  {purchaseStatus && <small className="gs-end-local-note">{purchaseStatus}</small>}
                  {!PAYMENTS_ARE_LIVE && revives <= 0 && (
                    <small className="gs-end-local-note">
                      No arcade contract configured — revives are granted, not charged.
                    </small>
                  )}
                </>
              )}
              {game.status === "won" && mode === "levels" && !isLastLevel && (
                <button className="gs-end-next" type="button" onClick={goToNextLevel}>
                  <ChevronsRight />
                  <span>
                    Level {levelIndex + 2} · {getLevel(levelIndex + 1).cols}×
                    {getLevel(levelIndex + 1).rows}
                  </span>
                </button>
              )}
              <button className="gs-end-save" type="button" disabled={isOnchainPending || recordSaved} onClick={saveRecord}>
                <Save />
                <span>
                  {isOnchainPending
                    ? "Saving..."
                    : recordSaved
                      ? "Saved"
                      : `Save Record${PAYMENTS_ARE_LIVE ? ` · ${formatUsd(recordPriceCents)}` : ""}`}
                </span>
              </button>
              <button className="gs-end-play" type="button" onClick={playAgain}>
                <Play />
                <span>Play Again</span>
              </button>
              <button className="gs-end-exit" type="button" onClick={exitGame}>
                Exit
              </button>
              {recordStatus && <small>{recordStatus}</small>}
            </div>
          </div>
        </section>
      )}

      {isShopOpen && (
        <div className="gs-shop" role="dialog" aria-modal="true" aria-label="Revives">
          <div className="gs-shop-card">
            <button
              className="gs-shop-close"
              type="button"
              onClick={() => setIsShopOpen(false)}
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <h3>Revives</h3>
            <p className="gs-shop-lead">
              A revive puts you back into the run you just lost, with the score intact and a way
              out of the spot that killed you.
            </p>

            <div className="gs-shop-balance">
              <Heart size={14} />
              <strong>{revives}</strong>
              <span>in stock</span>
            </div>

            <div className="gs-shop-pack">
              <span className="gs-shop-pack-top">
                <strong>{packRevives * packQuantity} revives</strong>
                <em>
                  {PAYMENTS_ARE_LIVE
                    ? formatUsd(
                        packRevivePriceCents === null ? null : packRevivePriceCents * packQuantity
                      )
                    : "free"}
                </em>
              </span>
              <small>
                {packQuantity} pack{packQuantity > 1 ? "s" : ""} × {packRevives} revives
                {PAYMENTS_ARE_LIVE
                  ? ` · ≈ ${formatEth(
                      packRevivePrice === null ? null : packRevivePrice * BigInt(packQuantity)
                    )}`
                  : " · local sandbox"}
              </small>

              <div className="gs-shop-stepper">
                <button
                  type="button"
                  onClick={() => setPackQuantity((value) => Math.max(1, value - 1))}
                  disabled={packQuantity <= 1}
                  aria-label="One pack fewer"
                >
                  <Minus size={16} />
                </button>
                <strong aria-live="polite">{packQuantity}</strong>
                <button
                  type="button"
                  onClick={() => setPackQuantity((value) => value + 1)}
                  aria-label="One pack more"
                >
                  <Plus size={16} />
                </button>
              </div>

              <button
                className="gs-shop-buy"
                type="button"
                onClick={() => void buyPacks()}
                disabled={isBuying || (PAYMENTS_ARE_LIVE && packRevivePrice === null)}
              >
                {isBuying
                  ? "Paying..."
                  : `Buy · ${
                      PAYMENTS_ARE_LIVE
                        ? formatUsd(
                            packRevivePriceCents === null
                              ? null
                              : packRevivePriceCents * packQuantity
                          )
                        : "free"
                    }`}
              </button>
              {purchaseStatus && <p className="gs-shop-note">{purchaseStatus}</p>}
            </div>

            {!PAYMENTS_ARE_LIVE && (
              <p className="gs-shop-note">
                Local build — nothing is charged. Packs are credited to this device only.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function getStreakUi(streak: StreakState | null, now: number) {
  if (!streak || streak.streak === 0) {
    return { count: 0, timer: "0:00:00" };
  }

  const nextCheckInAt = streak.nextCheckInAt ? new Date(streak.nextCheckInAt).getTime() : 0;
  const expiresAt = streak.expiresAt ? new Date(streak.expiresAt).getTime() : 0;

  if (nextCheckInAt > now) {
    return {
      count: streak.streak,
      timer: formatDuration(nextCheckInAt - now)
    };
  }

  if (expiresAt > now) {
    return {
      count: streak.streak,
      timer: formatDuration(expiresAt - now)
    };
  }

  return { count: 0, timer: "0:00:00" };
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function getStoredBestRunCells() {
  try {
    const value = window.localStorage.getItem(BEST_RUN_STORAGE_KEY);
    const parsed = value ? Number.parseInt(value, 10) : 0;

    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  } catch {
    return 0;
  }
}

function storeBestRunCells(value: number) {
  try {
    window.localStorage.setItem(BEST_RUN_STORAGE_KEY, String(value));
  } catch {
    // Local storage can be blocked in private/webview contexts; gameplay should continue.
  }
}

const STREAK_CACHE_PREFIX = "snake.streak.";

function isStreakState(value: unknown): value is StreakState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.authenticated === "boolean" &&
    typeof v.canCheckIn === "boolean" &&
    typeof v.checkedInToday === "boolean" &&
    typeof v.streak === "number" &&
    Number.isFinite(v.streak) &&
    v.streak >= 0
  );
}

function readCachedStreak(address: string): StreakState | null {
  try {
    const raw = window.localStorage.getItem(STREAK_CACHE_PREFIX + address.toLowerCase());
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStreakState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedStreak(address: string, value: StreakState) {
  try {
    window.localStorage.setItem(STREAK_CACHE_PREFIX + address.toLowerCase(), JSON.stringify(value));
  } catch {
    /* ignore */
  }
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
  width: number,
  height: number,
  game: GameState,
  coinImage: HTMLImageElement | null
) {
  const cell = width / game.cols;

  context.clearRect(0, 0, width, height);

  if (game.food) {
    drawCoin(context, game.food, cell, coinImage);
  }

  // Draw tail → head so head renders on top
  for (let i = game.snake.length - 1; i >= 0; i--) {
    drawSnakeSegment(context, game.snake[i], cell, i === 0);
  }
}

function drawSnakeSegment(
  context: CanvasRenderingContext2D,
  part: Point,
  cell: number,
  isHead: boolean
) {
  const pad = Math.max(1, Math.ceil(cell * 0.045));
  const x = part.x * cell + pad;
  const y = part.y * cell + pad;
  const w = cell - pad * 2;
  const r = Math.max(5, Math.round(cell * 0.14));

  context.save();

  context.shadowColor = isHead ? "rgba(0,229,255,0.72)" : "rgba(0,82,255,0.42)";
  context.shadowBlur = isHead ? 18 : 10;

  const grad = context.createLinearGradient(x, y, x + w, y + w);
  if (isHead) {
    grad.addColorStop(0, "rgba(35,43,58,0.98)");
    grad.addColorStop(0.55, "rgba(17,24,38,0.98)");
    grad.addColorStop(1, "rgba(8,12,22,0.98)");
  } else {
    grad.addColorStop(0, "rgba(22,30,46,0.82)");
    grad.addColorStop(1, "rgba(7,12,23,0.9)");
  }
  context.fillStyle = grad;
  roundedRect(context, x, y, w, w, r);
  context.fill();

  context.shadowBlur = 0;
  context.strokeStyle = isHead ? "rgba(0,229,255,0.95)" : "rgba(0,229,255,0.55)";
  context.lineWidth = isHead ? 1.25 : 1;
  roundedRect(context, x + 0.5, y + 0.5, w - 1, w - 1, r);
  context.stroke();

  const hl = context.createLinearGradient(x, y, x, y + w * 0.35);
  hl.addColorStop(0, isHead ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = hl;
  roundedRect(context, x + 1, y + 1, w - 2, w * 0.35, r);
  context.fill();

  context.restore();

  // Eyes at bottom of head (items-end pb-1.5 gap-1.5 in design)
  if (isHead) {
    const eyeR = cell * 0.058;
    const eyeY = y + w - eyeR * 2.2 - pad * 0.4;
    const gap = w * 0.18;
    context.save();
    context.shadowColor = "rgba(255,255,255,0.95)";
    context.shadowBlur = 6;
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(x + w / 2 - gap, eyeY, eyeR, 0, Math.PI * 2);
    context.arc(x + w / 2 + gap, eyeY, eyeR, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}

function drawCoin(
  context: CanvasRenderingContext2D,
  food: Point,
  cell: number,
  coinImage: HTMLImageElement | null
) {
  const inset = cell * 0.08;
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

export default Game;
