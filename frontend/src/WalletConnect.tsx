import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiweMessage } from "siwe";
import type { Connector } from "wagmi";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { base } from "wagmi/chains";

type BaseAccountProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

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

function getAuthAccount(authResult: unknown) {
  const result = authResult as {
    accounts?: Array<{
      address?: string;
      capabilities?: {
        signInWithEthereum?: {
          message?: string;
          signature?: string;
        };
      };
    }>;
  };

  return result.accounts?.[0];
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

  // Inner step: SIWE handshake on an already-connected Smart Wallet.
  // Inside Base App the wallet auto-signs SIWE silently (no popup).
  const authenticateSmartWalletSession = async (silent = false) => {
    if (!baseAccountConnector) {
      throw new Error("Smart wallet is unavailable");
    }

    const nonce = await getAuthNonce();
    const provider = (await baseAccountConnector.getProvider()) as BaseAccountProvider;
    const authResult = await provider.request({
      method: "wallet_connect",
      params: [
        {
          version: "1",
          capabilities: {
            signInWithEthereum: {
              nonce,
              chainId: "0x2105"
            }
          }
        }
      ]
    });
    const account = getAuthAccount(authResult);
    const siwe = account?.capabilities?.signInWithEthereum;

    if (!account?.address || !siwe?.message || !siwe.signature) {
      throw new Error("SIWE response is incomplete");
    }

    const session = await verifyAuthSession(siwe.message, siwe.signature, "Smart Wallet");
    setAuthState({
      address: session.address,
      mode: session.mode
    });
    setIsOpen(false);
    void silent; // eslint placation; silent is used by callers via try/catch
  };

  const connectSmartWallet = async (showError = true) => {
    if (!baseAccountConnector) {
      if (showError) {
        setError("Smart wallet is unavailable");
      }
      return;
    }

    if (showError) {
      setError(null);
    }

    try {
      await connectAsync({ connector: baseAccountConnector });
      await authenticateSmartWalletSession();
    } catch (caught) {
      if (showError) {
        setError(getFriendlyWalletError(caught));
      }
    }
  };

  // Auto-authenticate Smart Wallet after wagmi reconnect restores the session.
  // Inside Base App mini-app context this is silent (no signature prompt).
  useEffect(() => {
    if (autoAuthRef.current) return;
    if (!sessionChecked) return;
    if (!isConnected || !address || authState) return;
    if (activeConnector?.id !== "baseAccount") return;

    autoAuthRef.current = true;
    void authenticateSmartWalletSession(true).catch(() => {
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
      const connectedAddress = result.accounts[0];

      if (!connectedAddress) {
        throw new Error("No wallet address returned");
      }

      const nonce = await getAuthNonce();
      const message = new SiweMessage({
        domain: window.location.host,
        address: connectedAddress,
        statement: "Sign in to Snake.",
        uri: window.location.origin,
        version: "1",
        chainId: result.chainId ?? base.id,
        nonce
      }).prepareMessage();
      const signature = await signMessageAsync({ message });
      const session = await verifyAuthSession(message, signature, "Standard Wallet");

      setAuthState({
        address: session.address,
        mode: session.mode
      });
      setIsOpen(false);
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
