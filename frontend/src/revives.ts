import { useEffect, useState } from "react";

export type RevivePack = {
  id: string;
  revives: number;
  priceUsd: number;
  label: string;
  hint: string;
};

// The prices we intend to charge once payments are wired. Nothing is charged
// today: a purchase credits the local balance and appends to a local ledger, so
// whatever entitlement the server ends up owning can be reconciled against it.

// The stocking-up offer, sold in the shop by the packful.
export const PACK_REVIVE: RevivePack = {
  id: "pack20",
  revives: 20,
  priceUsd: 10,
  label: "20 revives",
  hint: "Half price per revive"
};

// Sold only at the moment of the crash, where one revive is worth a dollar
// because the run is still on the table. Deliberately absent from the shop.
export const SINGLE_REVIVE: RevivePack = {
  id: "single",
  revives: 1,
  priceUsd: 1,
  label: "1 revive",
  hint: "Get back up exactly where you crashed"
};

export const PAYMENTS_ARE_LIVE = false;

type LedgerEntry = {
  at: number;
  packId: string;
  // Price and revives are the totals for the whole purchase; quantity says how
  // many packs made them up.
  priceUsd: number;
  quantity: number;
  revives: number;
};

const BALANCE_KEY = "snake.revives";
const LEDGER_KEY = "snake.revives.ledger";
const LEDGER_LIMIT = 100;
// Balance lives in one place but is read by the stats bar, the game-over screen
// and the shop at the same time. One event keeps all of them in step.
const CHANGED_EVENT = "snake:revives-changed";

export function getRevives() {
  try {
    const raw = window.localStorage.getItem(BALANCE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : 0;

    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  } catch {
    return 0;
  }
}

function setRevives(value: number) {
  const next = Math.max(0, Math.floor(value));

  try {
    window.localStorage.setItem(BALANCE_KEY, String(next));
  } catch {
    // Blocked storage: the balance still works for this session via the event.
  }

  window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { balance: next } }));

  return next;
}

export function addRevives(amount: number) {
  return setRevives(getRevives() + Math.max(0, Math.floor(amount)));
}

// Returns false when there was nothing to spend, so the caller never consumes a
// revive it didn't have.
export function spendRevive() {
  const balance = getRevives();

  if (balance <= 0) {
    return false;
  }

  setRevives(balance - 1);
  return true;
}

export function getPurchaseLedger(): LedgerEntry[] {
  try {
    const raw = window.localStorage.getItem(LEDGER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];

    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

// Local-only purchase: no wallet call, no money moves. The ledger entry is what
// a real payment would later carry a tx hash for. Quantity is uncapped — the
// shop lets a player take as many packs as they care to.
export function purchasePack(pack: RevivePack, quantity = 1) {
  const packs = Math.max(1, Math.floor(quantity));
  const entry: LedgerEntry = {
    at: Date.now(),
    packId: pack.id,
    priceUsd: pack.priceUsd * packs,
    quantity: packs,
    revives: pack.revives * packs
  };

  try {
    const ledger = [...getPurchaseLedger(), entry].slice(-LEDGER_LIMIT);
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // Ledger is a convenience for reconciliation, not a gate on the credit.
  }

  return addRevives(entry.revives);
}

export function useRevives() {
  const [balance, setBalance] = useState(getRevives);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { balance?: number } | null;

      setBalance(typeof detail?.balance === "number" ? detail.balance : getRevives());
    };

    window.addEventListener(CHANGED_EVENT, handler);

    return () => window.removeEventListener(CHANGED_EVENT, handler);
  }, []);

  return balance;
}
