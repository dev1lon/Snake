import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [isOpen, setIsOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      try {
        const response = await fetch(`${API_URL}/api/auth/me`, {
          credentials: "include"
        });

        if (!response.ok) {
          return;
        }

        const session = (await response.json()) as AuthResponse;

        if (session.authenticated) {
          setAuthState({
            address: session.address,
            mode: session.mode
          });
        }
      } catch {
        setAuthState(null);
      }
    };

    void restoreSession();
  }, []);

  const connectSmartWallet = async () => {
    if (!baseAccountConnector) {
      setError("Smart wallet is unavailable");
      return;
    }

    setError(null);

    try {
      const nonce = await getAuthNonce();

      await connectAsync({ connector: baseAccountConnector });
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Smart wallet connection failed");
    }
  };

  const connectStandardWallet = async () => {
    if (!standardConnector) {
      setError("Standard wallet is unavailable");
      return;
    }

    setError(null);

    try {
      const nonce = await getAuthNonce();
      const result = await connectAsync({ connector: standardConnector as Connector });
      const connectedAddress = result.accounts[0];

      if (!connectedAddress) {
        throw new Error("No wallet address returned");
      }

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
      setError(caught instanceof Error ? caught.message : "Standard wallet connection failed");
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
              <button type="button" disabled={isPending || !baseAccountConnector} onClick={connectSmartWallet}>
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
