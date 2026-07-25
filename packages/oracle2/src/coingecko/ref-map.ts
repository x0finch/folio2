import type { AssetPlatform, CoinListItem } from "@folio/coingecko-client";
import { tokenRef } from "@folio/oracle-ref";
import type { CgkRefRow } from "../types";
import { NON_EVM_PLATFORMS } from "./platform-slugs";

// 把 CoinGecko 的两个端点摊平成「链上地址 → coin id」的映射行(ADR 0022)。
//
// **纯函数,零 IO** —— 拉取在 source 里,灌库在 store 里,cron 只是把三者串起来的调用点。
// 好处是这一步能拿 fixture 钉死:响应几 MB、四万来行,出了错在生产上是「某条链的币全部
// 没价没图」,不会有任何报错。

export interface RefMapResult {
  rows: CgkRefRow[];
  // **我们支持的非 EVM 链**里,在 CoinGecko 的平台表中查无此 id 的。这是真正的告警:
  // 对照断了 → 那条链从此没价没图且不报错。调用方须记 warning(见 cgk-refs.ts)。
  unmatchedPlatforms: string[];
  // 丢掉的映射条目数:CoinGecko 上我们不追踪的那两百来条链。正常、且数目很大,纯计数。
  skipped: number;
}

// CoinGecko 的 asset_platform id → 我们的命名者。
function namerByPlatformId(platforms: readonly AssetPlatform[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of platforms) {
    if (!p?.id) continue;
    // EVM:两边都归 `evm:<chainId>`,靠数字对齐。
    if (p.chain_identifier != null && Number.isFinite(p.chain_identifier)) {
      out.set(p.id, `evm:${p.chain_identifier}`);
    }
  }
  // 非 EVM:走显式对照(我们的命名者 → 它的 id),覆盖式写入 —— 对照表说了算。
  for (const [namer, platformId] of Object.entries(NON_EVM_PLATFORMS)) {
    out.set(platformId, namer);
  }
  return out;
}

export function toCgkRefRows(
  coins: readonly CoinListItem[],
  platforms: readonly AssetPlatform[],
): RefMapResult {
  const namerOf = namerByPlatformId(platforms);

  // 对照校验:我们指名要的那几条非 EVM 链,CoinGecko 的平台表里还在吗。
  const known = new Set(platforms.map((p) => p?.id).filter((id): id is string => !!id));
  const unmatchedPlatforms = Object.entries(NON_EVM_PLATFORMS)
    .filter(([, platformId]) => !known.has(platformId))
    .map(([namer]) => namer);

  const rows: CgkRefRow[] = [];
  let skipped = 0;
  for (const coin of coins) {
    const coinId = coin?.id;
    if (!coinId || !coin.platforms) continue;
    for (const [platformId, address] of Object.entries(coin.platforms)) {
      // 原生币在这里是空地址(`{"": ""}` 或空串)—— 不产行,它们靠 symbol 认。
      const addr = address?.trim();
      if (!platformId || !addr) continue;
      const namer = namerOf.get(platformId);
      if (!namer) {
        skipped += 1;
        continue;
      }
      // 地址归一(EVM 小写)由文法层按命名者决定,不在这里猜。
      rows.push({ ref: tokenRef.local(namer, addr), coinId });
    }
  }
  return { rows, unmatchedPlatforms, skipped };
}
