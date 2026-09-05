import { useEffect, useState } from "react";
import { API_URL } from "./api";
import { ARCADE_ADDRESS } from "./contracts";
import { authHeaders, getStoredAuthToken } from "./WalletConnect";

// Balance is purchases counted by the contract minus spends stored by the API.
export const PAYMENTS_ARE_LIVE = Boolean(ARCADE_ADDRESS);

// Shown until the contract's pack size loads.
export const DEFAULT_PACK_REVIVES = 20;

const CHANGED_EVENT = "snake:revives-changed";

let serverBalance = 0;
let authGeneration = 0;
let balanceAddress: string | null = null;
let pendingSpend: { token: string | null; id: string } | null = null;
window.addEventListener("snake:auth-changed", (event) => {
  const detail = (event as CustomEvent<{ address?: string }>).detail;
  balanceAddress = detail?.address ?? null;
  authGeneration += 1;
  serverBalance = 0;
  announce(0);
});

function announce(balance: number) {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { balance } }));
}

export async function refreshRevives(strict = false) {
  if (!PAYMENTS_ARE_LIVE) {
    if (strict) throw new Error("Revives are temporarily unavailable. Please try again later.");
    return 0;
  }

  if (!balanceAddress) {
    if (strict) throw new Error("Sign in before using or buying revives.");
    return 0;
  }
  const generation = authGeneration;
  try {
    const response = await fetch(`${API_URL}/api/revives`, {
      credentials: "include",
      headers: authHeaders(),
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      if (response.status === 401 && generation === authGeneration) {
        serverBalance = 0;
        announce(0);
      }
      if (strict) throw new Error("Could not check your revives. Try again before buying more.");
      // Signed out, or the backend can't reach the chain. Keep the last known
      // number rather than flashing a zero the player hasn't earned.
      return serverBalance;
    }

    const data = (await response.json()) as { balance?: unknown };

    if (generation !== authGeneration) {
      if (strict) throw new Error("Wallet changed. Try again.");
      return serverBalance;
    }
    if (typeof data.balance === "number" && Number.isFinite(data.balance)) {
      serverBalance = Math.max(0, data.balance);
      announce(serverBalance);
    } else if (strict) {
      throw new Error("Could not check your revives. Try again.");
    }
  } catch (error) {
    if (strict) throw error;
    // Offline: same reasoning as above.
  }

  return serverBalance;
}

/// Spends one revive. False means there was nothing to spend, so the caller
/// never consumes what the player doesn't have.
export function hasPendingReviveSpend() {
  return pendingSpend !== null && pendingSpend.token === getStoredAuthToken();
}

export async function spendRevive() {
  if (!PAYMENTS_ARE_LIVE) {
    throw new Error("Revives are temporarily unavailable. Please try again later.");
  }

  const generation = authGeneration;
  const token = getStoredAuthToken();
  if (!pendingSpend || pendingSpend.token !== token) {
    pendingSpend = { token, id: crypto.randomUUID() };
  }
  const request = pendingSpend;
  try {
    const response = await fetch(`${API_URL}/api/revives/use`, {
      method: "POST",
      credentials: "include",
      headers: { ...authHeaders(), "Idempotency-Key": request.id },
      signal: AbortSignal.timeout(10_000)
    });
    const data = (await response.json().catch(() => null)) as { balance?: number } | null;

    if (generation !== authGeneration) return false;
    if (typeof data?.balance === "number") {
      serverBalance = Math.max(0, data.balance);
      announce(serverBalance);
    }

    if (response.ok || response.status === 409) pendingSpend = null;
    if (!response.ok && response.status !== 409) {
      throw new Error("Could not use your revive. Retry; you will not be charged twice.");
    }
    return response.ok;
  } catch {
    throw new Error("Could not use your revive. Retry; you will not be charged twice.");
  }
}

export function getRevives() {
  return serverBalance;
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
