import { QueryClient } from "@tanstack/react-query";
import { createConfig, http } from "wagmi";
import { base } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";

export const queryClient = new QueryClient();

export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [
    baseAccount({
      appName: "Snake"
    }),
    injected()
  ],
  transports: {
    [base.id]: http()
  }
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
