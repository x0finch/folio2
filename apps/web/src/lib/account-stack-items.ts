import {
  DEFI_FALLBACK_PROTOCOL,
  type OverviewBalance,
  parseDefiMeta,
  ZERO_DISPLAY_USD,
} from "./account-view";
import { viewKind } from "./balance-kind";
import { defiLogoUrl } from "./logo";
import { perpPositionMetaOf } from "./perp";

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
// 排序按美元量级降序。**三类的「量级」各取各的口径**:
//   · 现货 → 行的 `usdValue`(带符号累加,保持原有阈值行为)
//   · DeFi → 各腿 `|usdValue|` 之和(借款腿是负的;对冲仓净值≈0 却是个大仓位 ——
//     同 `dropEmptyDefiGroups` 与 ADR 0040 的毛敞口口径)
//   · 永续 → **meta 里的名义敞口**,不是行的 `usdValue`(那个恒为 0,见 `perpPositionMetaOf`)
//
// 渲染交给全站统一的 <AvatarStack>。
export interface StackItem {
  logo?: string;
  name: string;
  k: string;
}

interface Slot {
  name: string;
  logo?: string;
  value: number;
}

export function accountStackItems(balances: OverviewBalance[]): StackItem[] {
  const slots = new Map<string, Slot>();
  // logo 取**首个有图的**(不是首见那行):同一个币可能先出现在一条没富化到图的行上。
  const add = (key: string, name: string, logo: string | undefined, value: number) => {
    const cur = slots.get(key);
    if (!cur) slots.set(key, { name, logo, value });
    else {
      cur.value += value;
      cur.logo ??= logo;
    }
  };

  for (const b of balances) {
    switch (viewKind(b)) {
      case "spot": {
        const symbol = b.symbol ?? ""; // 富化后恒有(#243:显示名从 Token 取);缺失兜底空串
        add(symbol.toUpperCase(), symbol, b.logo, b.usdValue);
        break;
      }
      case "perp_position": {
        // coin 与名义敞口都住 meta(#243)。meta 坏/缺 → 这一行没有可显示的身份,跳过(不拿空图占一格)。
        const meta = perpPositionMetaOf(b.metaJson);
        if (!meta) continue;
        // 图来自展示富化(`perpTokenId` 那道门,#133):永续行的 token_id 写快照时就定死了,
        // 这里不再按 symbol 猜一次 —— 猜出来的会和快照里冻的身份不是同一个。
        add(meta.coin.toUpperCase(), meta.coin, b.logo, Math.abs(meta.positionValue));
        break;
      }
      case "defi": {
        const meta = parseDefiMeta(b.metaJson);
        const protocol = meta.protocol ?? DEFI_FALLBACK_PROTOCOL;
        // 协议图随余额 meta 一起落进了快照(#126),经 /api/logo/defi 代理(隐私:客户端零第三方
        // CDN,ADR 0008);无图 → undefined,<AvatarStack> 回退首字母。
        add(
          `protocol:${protocol}`,
          protocol,
          defiLogoUrl(protocol, meta.protocolLogo),
          Math.abs(b.usdValue),
        );
        break;
      }
      // perp_equity:抵押物,不入叠标(见文件头)。
    }
  }

  return [...slots.entries()]
    .filter(([, s]) => Math.abs(s.value) >= ZERO_DISPLAY_USD) // 合计后显示为 $0.00 的不入叠标
    .sort((a, b) => Math.abs(b[1].value) - Math.abs(a[1].value))
    .map(([k, s]) => ({ logo: s.logo, name: s.name, k }));
}
