import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
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
  message: string;
  mode: WalletMode;
  signature: string;
};

function createNonce() {
  return window.crypto.randomUUID().replace(/-/g, "");
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

  const connectSmartWallet = async () => {
    if (!baseAccountConnector) {
      setError("Smart wallet is unavailable");
      return;
    }

    setError(null);

    try {
      const nonce = createNonce();

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

      setAuthState({
        address: account.address,
        message: siwe.message,
        mode: "Smart Wallet",
        signature: siwe.signature
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
      const result = await connectAsync({ connector: standardConnector as Connector });
      const connectedAddress = result.accounts[0];

      if (!connectedAddress) {
        throw new Error("No wallet address returned");
      }

      const message = new SiweMessage({
        domain: window.location.host,
        address: connectedAddress,
        statement: "Sign in to Sneak.",
        uri: window.location.origin,
        version: "1",
        chainId: result.chainId ?? base.id,
        nonce: createNonce()
      }).prepareMessage();
      const signature = await signMessageAsync({ message });

      setAuthState({
        address: connectedAddress,
        message,
        mode: "Standard Wallet",
        signature
      });
      setIsOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Standard wallet connection failed");
    }
  };

  const disconnectWallet = () => {
    disconnect();
    setAuthState(null);
    setError(null);
    setIsOpen(false);
  };

  return (
    <div className="wallet-widget">
      {isConnected ? (
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
