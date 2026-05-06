import { QueryClient } from "@tanstack/react-query";
import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { baseAccount, injected } from "wagmi/connectors";

export const queryClient = new QueryClient();
const builderCodeSuffix =
  "0x62635f38776576327439680b0080218021802180218021802180218021802180218021";

export const wagmiConfig = createConfig({
  chains: [base, baseSepolia],
  dataSuffix: builderCodeSuffix,
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
