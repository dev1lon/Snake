/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BASE_APP_LABEL?: string;
  readonly VITE_BASE_APP_LINK?: string;
  readonly VITE_BUILDER_CODE_SUFFIX?: string;
  readonly VITE_CREATOR_HANDLE?: string;
  readonly VITE_CREATOR_URL?: string;
  readonly VITE_RECORD_CONTRACT_ADDRESS?: string;
  readonly VITE_REQUIRE_BASE_APP?: string;
  readonly VITE_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
