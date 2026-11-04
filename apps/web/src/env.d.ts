/// <reference types="vite/client" />

/** Version of apps/web (package.json), injected by Vite `define`. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Base URL of the API; default `/api` (Vite proxy in dev, same-site proxy in prod). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
