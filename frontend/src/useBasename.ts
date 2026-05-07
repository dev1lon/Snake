import { useEffect, useState } from "react";
import { type Address, createPublicClient, http, namehash } from "viem";
import { base } from "viem/chains";

// Base mainnet L2 ENS resolver — official Basenames contract.
const L2_RESOLVER_ADDRESS = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" as const;

const L2ResolverAbi = [
  {
    inputs: [{ name: "node", type: "bytes32" }],
    name: "name",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function"
  }
] as const;

const client = createPublicClient({ chain: base, transport: http() });
const cache = new Map<string, string | null>();

function getReverseNode(address: Address) {
  // ENSIP-19 reverse name on Base: <address>.<cointypeHex>.reverse
  // cointype = 0x80000000 | 8453 = 0x80002105 → "80002105"
  const addressLower = address.toLowerCase().slice(2);
  return namehash(`${addressLower}.80002105.reverse`);
}

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
      .readContract({
        address: L2_RESOLVER_ADDRESS,
        abi: L2ResolverAbi,
        functionName: "name",
        args: [getReverseNode(address)]
      })
      .then((resolved) => {
        if (cancelled) return;
        const value = typeof resolved === "string" && resolved.length > 0 ? resolved : null;
        cache.set(key, value);
        setName(value);
      })
      .catch((err) => {
        console.warn("Basename resolution failed", err);
        cache.set(key, null);
      });

    return () => {
      cancelled = true;
    };
  }, [address]);

  return name;
}
