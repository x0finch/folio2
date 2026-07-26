import type { AssetPlatform, CoinListItem } from "@folio/coingecko-client";
import { tokenRef } from "@folio/oracle-ref";
import type { RefIndexFetch } from "@folio/oracle2-basic";
import { NON_EVM_PLATFORMS, UPSTREAM_ID } from "./constants";

// 把 CoinGecko 的两个端点摊平成全局映射行(ADR 0022)。
//
// **纯函数,零 IO** —— 拉取在 upstream 里,灌库在 store 里,cron 只是把三者串起来的调用点。
// 好处是这一步能拿 fixture 钉死:响应几 MB、四万来行,出了错在生产上是「某条链的币全部
// 没价没图」,不会有任何报错。
//
// 这个文件住在 adapter 包里,契约层不知道上游有几个端点、返回什么形状。

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

export function toRefIndexRows(
  coins: readonly CoinListItem[],
  platforms: readonly AssetPlatform[],
): RefIndexFetch {
  const namerOf = namerByPlatformId(platforms);

  // 对照校验:我们指名要的那几条非 EVM 链,CoinGecko 的平台表里还在吗。
  const known = new Set(platforms.map((p) => p?.id).filter((id): id is string => !!id));
  const unmatchedPlatforms = Object.entries(NON_EVM_PLATFORMS)
    .filter(([, platformId]) => !known.has(platformId))
    .map(([namer]) => namer);

  const rows: RefIndexFetch["rows"] = [];
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
      rows.push({ ref: tokenRef.local(namer, addr), namer: UPSTREAM_ID, localName: coinId });
    }
  }
  return { rows, unmatchedPlatforms, skipped };
}
