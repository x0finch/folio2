// Pure: reads a name -> value map, so both the Worker env and the Node ref-index script share it.
//
// `COINGECKO_API_BASE` overrides the base URL; unset in production (official free/pro base by key presence),
// set only by local perf runs. Read by name because it's not in the generated `Env` type.
// Empty string counts as unset.
export const coinGeckoConfigOf = (vars: Record<string, string | undefined>) => ({
  apiKey: vars.COINGECKO_API_KEY || undefined,
  baseUrl: vars.COINGECKO_API_BASE?.trim() || undefined,
});
