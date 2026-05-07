import { useEffect, useState } from "react";
import { type Address, createPublicClient, http } from "viem";
import { base } from "viem/chains";

// ENSIP-11 coin type for an EVM chain: 0x80000000 | chainId
// For Base mainnet (8453) this resolves Basenames via ENSIP-10 wildcard.
const BASE_COIN_TYPE = BigInt(0x80000000 | base.id);

const client = createPublicClient({ chain: base, transport: http() });

const cache = new Map<string, string | null>();

export function useBasename(address?: Address) {
  const [name, setName] = useState<string | null>(() => {
    if (!address) return null;
    return cache.get(address.toLowerCase()) ?? null;
  });

  useEffect(() => {
    if (!address) {
      setName(null);
      return;
    }
    const key = address.toLowerCase();
    if (cache.has(key)) {
      setName(cache.get(key) ?? null);
      return;
    }

    let cancelled = false;
    void client
      .getEnsName({
        address,
        coinType: BASE_COIN_TYPE
      })
      .then((resolved) => {
        if (cancelled) return;
        cache.set(key, resolved ?? null);
        setName(resolved ?? null);
      })
      .catch(() => {
        cache.set(key, null);
      });

    return () => {
      cancelled = true;
    };
  }, [address]);

  return name;
}
