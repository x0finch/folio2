import { env } from "cloudflare:workers";

// Booleans only, never values. CEX accounts use per-account keys, so they're not listed.
export function handleGetProviderKeyStatus() {
  return {
    ZERION_API_KEY: Boolean(env.ZERION_API_KEY),
    COINSTATS_API_KEY: Boolean(env.COINSTATS_API_KEY),
  };
}
