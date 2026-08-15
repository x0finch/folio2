import {
  DEFI_FALLBACK_PROTOCOL,
  type OverviewBalance,
  parseDefiMeta,
} from "../../../lib/account-view";
import { viewKind } from "../../../lib/balance-kind";
import { defiLogoUrl } from "../../../lib/logo";
import { perpPositionMetaOf } from "../../../lib/perp";
import { buildStack, type StackEntry, type StackItem } from "../../../lib/stack-items";

// 账户行那一排小圆头像 → items(纯逻辑,可单测)。**三种持仓都进来**(#133):
//   · 现货 → 币的图标
//   · 永续仓位 → 标的币的图标(在交易哪些币)
//   · DeFi → 协议的图标(在哪些协议里有仓位)
//   · 永续权益 → **不进**:它是抵押物,不是「持有什么」
//
// 从前这里只取现货(叫 `tokenStackItems`),于是纯永续 / 纯 DeFi 的账户那一排是空的 —— 靠
// `min-h-6` 撑着行高,信息量为零。
//
// **去重按「这格头像画的是什么」,不按来源。** 同一个账户里 BTC 现货与 BTC 永续画的是同一个图,
// 合成一格(并排两个一样的 BTC 看着像 bug);协议另起一族(`protocol:` 前缀)—— Aave 这个**协议**
// 与 AAVE 这个**币**是两回事,各占一格,哪怕图长得像。
//
// 累加 / 砍尘埃 / 降序交给 `buildStack`(三处叠标共用那一段);本文件只负责**每一行的量级取哪个数**:
//   · 现货 → 行的 `usdValue`(带符号,同一个币的多笔可以互相抵消)
//   · DeFi → 各腿 `|usdValue|`(借款腿是负的;对冲仓净值≈0 却是个大仓位 —— 同 `dropEmptyDefiGroups`
//     与 ADR 0040 的毛敞口口径)
//   · 永续 → **meta 里的名义敞口**,不是行的 `usdValue`(那个恒为 0,见 `perpPositionMetaOf`)
export function accountStackItems(balances: OverviewBalance[]): StackItem[] {
  const entries: StackEntry[] = [];
  for (const b of balances) {
    switch (viewKind(b)) {
      case "spot": {
        const symbol = b.symbol ?? ""; // 富化后恒有(#243:显示名从 Token 取);缺失兜底空串
        entries.push({
          k: symbol.toUpperCase(),
          name: symbol,
          logo: b.logo,
          magnitude: b.usdValue,
        });
        break;
      }
      case "perp_position": {
        // coin 与名义敞口都住 meta(#243)。meta 坏/缺 → 这一行没有可显示的身份,跳过(不拿空图占一格)。
        const meta = perpPositionMetaOf(b.metaJson);
        if (!meta) continue;
        // 图来自展示富化(`perpTokenId` 那道门,#133):永续行的 token_id 写快照时就定死了,
        // 这里不再按 symbol 猜一次 —— 猜出来的会和快照里冻的身份不是同一个。
        entries.push({
          k: meta.coin.toUpperCase(),
          name: meta.coin,
          logo: b.logo,
          magnitude: Math.abs(meta.positionValue),
        });
        break;
      }
      case "defi": {
        const meta = parseDefiMeta(b.metaJson);
        const protocol = meta.protocol ?? DEFI_FALLBACK_PROTOCOL;
        // 协议图随余额 meta 一起落进了快照(#126),经 /api/logo/defi 代理(隐私:客户端零第三方
        // CDN,ADR 0008);无图 → undefined,<AvatarStack> 回退首字母。
        entries.push({
          k: `protocol:${protocol}`,
          name: protocol,
          logo: defiLogoUrl(protocol, meta.protocolLogo),
          magnitude: Math.abs(b.usdValue),
        });
        break;
      }
      // perp_equity:抵押物,不入叠标(见文件头)。
    }
  }
  // 这一排可以是空的(从没同步过的账户),所以不要 `atLeastOne` —— 行高由调用点的 min-h 撑着。
  return buildStack(entries);
}
