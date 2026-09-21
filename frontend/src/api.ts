// On Vercel the API is served from the same origin as the game, so the base URL
// is empty: no CORS preflight, and the session can ride an HttpOnly cookie that
// in-app browsers would drop if it came from another domain. VITE_API_URL is
// for a split deployment (Render serves the API on its own host), and a dev
// server talks to the local backend.
function resolveApiUrl(value: string | undefined) {
  const configured = value?.trim();

  if (configured) {
    return configured.startsWith("http") ? configured : `https://${configured}`;
  }

  return import.meta.env.DEV ? "http://localhost:4000" : "";
}

export const API_URL = resolveApiUrl(import.meta.env.VITE_API_URL);
