import { env } from "cloudflare:workers";
import { createFxStore } from "@folio/db";
import { createCoinGeckoFxSource, createFxRates, type FxRates } from "@folio/fx";

// FX 汇率门面。读走 resolve(cache-only,软过期返最近值),写走 warm(sync 后,全局)。
export function buildFx(bindings: Cloudflare.Env): FxRates {
  return createFxRates({
    source: createCoinGeckoFxSource({ apiKey: bindings.COINGECKO_API_KEY || undefined }),
    store: createFxStore(bindings),
  });
}

// sync 后预热(全局、与用户无关):SUPPORTED 币种任一缺失/过期则一次刷新整表。
export async function warmFx(): Promise<void> {
  await buildFx(env).warm();
}
