import { QueryClient } from "@tanstack/react-query";
import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";

export const queryClient = new QueryClient();

export const wagmiConfig = createConfig({
  chains: [base, baseSepolia],
  connectors: [
    baseAccount({
      appName: "Snake"
    }),
    injected()
  ],
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http()
  }
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
