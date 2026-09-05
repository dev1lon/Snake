export type SentTransaction = { kind: "calls" | "transaction"; reference: string };
export type PendingRun = SentTransaction & { address: string; contract: string; hash?: string };
export type SyncResult = "synced" | "pending" | "failed";

const storageKey = "snake.pendingRuns.v1";
const fallback = new Map<string, PendingRun>();
const inFlight = new Map<string, Promise<SyncResult>>();
const keyOf = (run: PendingRun) => `${run.address.toLowerCase()}:${run.contract.toLowerCase()}:${run.reference}`;

export function pendingRuns(address: string, contract: string): PendingRun[] {
  let saved: PendingRun[] = [];
  try {
    const data: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (Array.isArray(data)) {
      saved = data.filter((run): run is PendingRun =>
        run && typeof run.address === "string" && typeof run.contract === "string" &&
        typeof run.reference === "string" && (run.kind === "calls" || run.kind === "transaction") &&
        (run.hash === undefined || /^0x[0-9a-fA-F]{64}$/.test(run.hash))
      );
    }
  } catch { /* Keep the queue in memory when storage is unavailable. */ }
  const merged = new Map(saved.map((run) => [keyOf(run), run]));
  fallback.forEach((run, key) => merged.set(key, run));
  return [...merged.values()].filter((run) =>
    (!address || run.address.toLowerCase() === address.toLowerCase()) &&
    (!contract || run.contract.toLowerCase() === contract.toLowerCase())
  );
}

export function queueRun(run: PendingRun) {
  const all = pendingRuns("", "");
  fallback.set(keyOf(run), run);
  const merged = new Map(all.map((item) => [keyOf(item), item]));
  merged.set(keyOf(run), run);
  try { localStorage.setItem(storageKey, JSON.stringify([...merged.values()])); } catch { /* memory fallback */ }
}

function removeRun(run: PendingRun) {
  const remaining = pendingRuns("", "").filter((item) => keyOf(item) !== keyOf(run));
  fallback.delete(keyOf(run));
  try { localStorage.setItem(storageKey, JSON.stringify(remaining)); } catch { /* Retry is idempotent. */ }
}

// This worker can only confirm and sync an existing payment; it cannot send one.
export function syncRun(
  run: PendingRun,
  confirm: (sent: SentTransaction) => Promise<{ hash: string | null; ok: boolean }>,
  persist: (hash: string) => Promise<boolean>
): Promise<SyncResult> {
  const key = keyOf(run);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const work = (async (): Promise<SyncResult> => {
    try {
      if (!run.hash) {
        const confirmed = await confirm(run);
        if (!confirmed.ok) {
          removeRun(run);
          return "failed";
        }
        if (!confirmed.hash) return "pending";
        run = { ...run, hash: confirmed.hash };
        queueRun(run);
      }
      if (!run.hash || !(await persist(run.hash))) return "pending";
      removeRun(run);
      return "synced";
    } catch {
      return "pending";
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, work);
  return work;
}
