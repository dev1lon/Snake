import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiweMessage } from "siwe";
import type { Address } from "viem";
import type { Connector } from "wagmi";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { base } from "wagmi/chains";

type WalletMode = "Smart Wallet" | "Standard Wallet";

type AuthState = {
  address: string;
  mode: WalletMode;
};

type AuthResponse = {
  address: string;
  authenticated: boolean;
  mode: WalletMode;
};

const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL);

function normalizeApiUrl(value: string | undefined) {
  if (!value) {
    return "http://localhost:4000";
  }

  return value.startsWith("http") ? value : `https://${value}`;
}

function formatAddress(address?: string) {
  if (!address) {
    return "";
  }

  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getFriendlyWalletError(caught: unknown) {
  if (!(caught instanceof Error)) {
    return "Wallet connection failed";
  }

  if (caught.message === "Load failed" || caught.message === "Failed to fetch") {
    return "Backend is unavailable. Try again after deploy finishes.";
  }

  return caught.message;
}

async function getAuthNonce() {
  const response = await fetch(`${API_URL}/api/auth/nonce`, {
    credentials: "include"
  });

  if (!response.ok) {
    throw new Error("Failed to create auth nonce");
  }

  const data = (await response.json()) as { nonce: string };
  return data.nonce;
}

async function verifyAuthSession(message: string, signature: string, mode: WalletMode) {
  const response = await fetch(`${API_URL}/api/auth/verify`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ message, mode, signature })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? "Wallet signature verification failed");
  }

  return (await response.json()) as AuthResponse;
}

export function WalletConnect() {
  const { address, isConnected, connector: activeConnector } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [isOpen, setIsOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const autoAuthRef = useRef(false);

  const baseAccountConnector = useMemo(
    () => connectors.find((connector) => connector.id === "baseAccount"),
    [connectors]
  );
  const standardConnector = useMemo(
    () => connectors.find((connector) => connector.id !== "baseAccount"),
    [connectors]
  );

  useEffect(() => {
    const restoreSession = async () => {
      if (!isConnected && !address) {
        setSessionChecked(true);
        return;
      }

      try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
          credentials: "include"
        });

        if (response.ok) {
          const session = (await response.json()) as AuthResponse;
          if (session.authenticated) {
            setAuthState({
              address: session.address,
              mode: session.mode
            });
          }
        }
      } catch {
        setAuthState(null);
      } finally {
        setSessionChecked(true);
      }
    };

    void restoreSession();
  }, [address, isConnected]);

  // Unified SIWE per Base "migrate to standard web app" guide:
  // signMessageAsync works for any connected wallet. Backend verifies
  // via viem.verifySiweMessage which supports EOA + ERC-1271 + EIP-6492
  // (Smart Wallet undeployed counterfactual signatures).
  const performSiwe = async (signer: Address, chainId: number, mode: WalletMode) => {
    const nonce = await getAuthNonce();
    const message = new SiweMessage({
      domain: window.location.host,
      address: signer,
      statement: "Sign in to Snake.",
      uri: window.location.origin,
      version: "1",
      chainId,
      nonce
    }).prepareMessage();

    const signature = await signMessageAsync({ message, account: signer });
    const session = await verifyAuthSession(message, signature, mode);

    setAuthState({ address: session.address, mode: session.mode });
    setIsOpen(false);
    return session;
  };

  const connectSmartWallet = async (showError = true) => {
    if (!baseAccountConnector) {
      if (showError) setError("Smart wallet is unavailable");
      return;
    }
    if (showError) setError(null);

    try {
      const result = await connectAsync({ connector: baseAccountConnector });
      const signer = result.accounts[0];
      if (!signer) throw new Error("No wallet address returned");
      await performSiwe(signer as Address, result.chainId ?? base.id, "Smart Wallet");
    } catch (caught) {
      if (showError) setError(getFriendlyWalletError(caught));
    }
  };

  // Auto-authenticate after wagmi reconnect restores the session.
  // Inside Base App, signMessageAsync on Smart Wallet completes silently.
  useEffect(() => {
    if (autoAuthRef.current) return;
    if (!sessionChecked) return;
    if (!isConnected || !address || authState) return;
    if (activeConnector?.id !== "baseAccount") return;

    autoAuthRef.current = true;
    void performSiwe(address as Address, base.id, "Smart Wallet").catch((err) => {
      console.warn("Auto SIWE failed", err);
      autoAuthRef.current = false;
    });
  }, [sessionChecked, isConnected, address, authState, activeConnector]);

  const connectStandardWallet = async () => {
    if (!standardConnector) {
      setError("Standard wallet is unavailable");
      return;
    }

    // injected() requires window.ethereum — not present on mobile browsers without extension
    const hasProvider = typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
    if (!hasProvider) {
      setError("No wallet extension found. Install MetaMask or use Smart Wallet.");
      return;
    }
    setError(null);

    try {
      const result = await connectAsync({ connector: standardConnector as Connector });
      const signer = result.accounts[0];
      if (!signer) throw new Error("No wallet address returned");
      await performSiwe(signer as Address, result.chainId ?? base.id, "Standard Wallet");
    } catch (caught) {
      setError(getFriendlyWalletError(caught));
    }
  };

  const disconnectWallet = () => {
    void fetch(`${API_URL}/api/auth/logout`, {
      method: "POST",
      credentials: "include"
    });
    disconnect();
    setAuthState(null);
    setError(null);
    setIsOpen(false);
  };

  return (
    <div className="wallet-widget">
      {isConnected || authState ? (
        <div className="wallet-connected">
          <span>{authState?.mode ?? "Wallet"}</span>
          <strong>{formatAddress(authState?.address ?? address)}</strong>
          <button type="button" title="Disconnect wallet" aria-label="Disconnect wallet" onClick={disconnectWallet}>
            <LogOut />
          </button>
        </div>
      ) : (
        <>
          <button
            className="wallet-trigger"
            type="button"
            aria-expanded={isOpen}
            onClick={() => setIsOpen((value) => !value)}
          >
            <Wallet />
            <span>Connect Wallet</span>
            <ChevronDown />
          </button>

          {isOpen && (
            <div className="wallet-menu">
              <button type="button" disabled={isPending || !baseAccountConnector} onClick={() => connectSmartWallet()}>
                Smart Wallet
              </button>
              <button type="button" disabled={isPending || !standardConnector} onClick={connectStandardWallet}>
                Standard Wallet
              </button>
            </div>
          )}
        </>
      )}

      {error && <span className="wallet-error">{error}</span>}
    </div>
  );
}
