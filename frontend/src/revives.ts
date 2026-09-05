import { useEffect, useState } from "react";
import { API_URL } from "./api";
import { ARCADE_ADDRESS } from "./contracts";
import { authHeaders } from "./WalletConnect";

// With the arcade contract deployed, revives are bought onchain and the
// balance is purchases (counted by the contract) minus spends (counted by the
// backend). Without it the game runs a local sandbox so the mechanic stays
// playable — nothing is charged and nothing leaves the device.
export const PAYMENTS_ARE_LIVE = Boolean(ARCADE_ADDRESS);

/// Pack size used by the sandbox and shown until the contract can be read.
export const SANDBOX_PACK_REVIVES = 20;

const BALANCE_KEY = "snake.revives";
const CHANGED_EVENT = "snake:revives-changed";

let serverBalance = 0;

function announce(balance: number) {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { balance } }));
}

// ── Sandbox balance (no contract configured) ────────────────────────────

function readSandbox() {
  try {
    const raw = window.localStorage.getItem(BALANCE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : 0;

    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  } catch {
    return 0;
  }
}

function writeSandbox(value: number) {
  const next = Math.max(0, Math.floor(value));

  try {
    window.localStorage.setItem(BALANCE_KEY, String(next));
  } catch {
    // Blocked storage: the balance still works for this session via the event.
  }

  announce(next);
  return next;
}

/// Sandbox-only purchase: credits the balance, charges nothing.
export function creditSandboxRevives(amount: number) {
  return writeSandbox(readSandbox() + Math.max(0, Math.floor(amount)));
}

// ── Live balance ────────────────────────────────────────────────────────

export async function refreshRevives() {
  if (!PAYMENTS_ARE_LIVE) {
    const sandbox = readSandbox();

    announce(sandbox);
    return sandbox;
  }

  try {
    const response = await fetch(`${API_URL}/api/revives`, {
      credentials: "include",
      headers: authHeaders()
    });

    if (!response.ok) {
      // Signed out, or the backend can't reach the chain. Keep the last known
      // number rather than flashing a zero the player hasn't earned.
      return serverBalance;
    }

    const data = (await response.json()) as { balance?: unknown };

    if (typeof data.balance === "number" && Number.isFinite(data.balance)) {
      serverBalance = Math.max(0, data.balance);
      announce(serverBalance);
    }
  } catch {
    // Offline: same reasoning as above.
  }

  return serverBalance;
}

/// Spends one revive. False means there was nothing to spend, so the caller
/// never consumes what the player doesn't have.
export async function spendRevive() {
  if (!PAYMENTS_ARE_LIVE) {
    const balance = readSandbox();

    if (balance <= 0) {
      return false;
    }

    writeSandbox(balance - 1);
    return true;
  }

  try {
    const response = await fetch(`${API_URL}/api/revives/use`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders()
    });
    const data = (await response.json().catch(() => null)) as { balance?: number } | null;

    if (typeof data?.balance === "number") {
      serverBalance = Math.max(0, data.balance);
      announce(serverBalance);
    }

    return response.ok;
  } catch {
    return false;
  }
}

export function getRevives() {
  return PAYMENTS_ARE_LIVE ? serverBalance : readSandbox();
}

export function useRevives() {
  const [balance, setBalance] = useState(getRevives);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { balance?: number } | null;

      setBalance(typeof detail?.balance === "number" ? detail.balance : getRevives());
    };

    window.addEventListener(CHANGED_EVENT, handler);

    // A signed-in balance lives on the server, so it isn't known at first
    // render — and it changes the moment a wallet signs in.
    const refresh = () => void refreshRevives();

    refresh();
    window.addEventListener("snake:auth-changed", refresh);

    return () => {
      window.removeEventListener(CHANGED_EVENT, handler);
      window.removeEventListener("snake:auth-changed", refresh);
    };
  }, []);

  return balance;
}
