import { QueryClient } from "@tanstack/react-query";
import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";

export const queryClient = new QueryClient();

// Falls back to the public Base endpoint, which rate-limits hard under real
// traffic. Set VITE_RPC_URL to a provider key restricted to your domain.
const rpcUrl = import.meta.env.VITE_RPC_URL;

export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [
    baseAccount({
      appName: "Snake"
    }),
    injected()
  ],
  transports: {
    [base.id]: http(rpcUrl)
  }
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
