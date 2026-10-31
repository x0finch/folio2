/** Bindings from `wrangler types`, plus secrets (set in .dev.vars or `wrangler secret`). */
export interface Env extends Omit<Bindings, 'AUTH_RATE_LIMIT'> {
  BETTER_AUTH_URL: string
  BETTER_AUTH_SECRET: string
  ENCRYPTION_SECRET: string
  /** Comma-separated extra origins serving the app. */
  TRUSTED_ORIGINS?: string
  /** Optional: absent in tests and local dev. */
  AUTH_RATE_LIMIT?: RateLimit
  /** Market-data base URLs; only the end-to-end tests set these (upstreams.ts). */
  DEFILLAMA_URL?: string
  FRANKFURTER_URL?: string
  COINGECKO_URL?: string
}
