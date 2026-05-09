function normalizeApiUrl(value: string | undefined) {
  if (!value) return "http://localhost:4000";
  return value.startsWith("http") ? value : `https://${value}`;
}

export const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL);
