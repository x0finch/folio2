import type { BybitCoin, BybitEarnPosition, BybitFundingCoin } from "@folio/bybit-client";
import type { Note, Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { PROVIDER_ID, STABLECOINS } from "./constants";

// 【bybit 的适配层:上游形状 → folio 的 `Balance`】——**纯函数,一个都不出网**(ADR 0036)。
// 逐字搬自 `packages/connectors/provider-bybit`,fixtures 一字节没动。

// 纯解析:统一账户 coin[] → Spot[]。与 IO 分离,golden test。
// amount=walletBalance(现金,不含 uPnL —— ADR 0032;**不用 equity**,它含合约浮盈)、value=usdValue
// (Bybit 自带,零额外请求)、price=usdValue/amount(反推单价);跳过空 coin / walletBalance≤0;kind:spot。
// locked>0 的币在【它自己那笔 balance】挂一个 `Locked` 段(icon warning;`${锁定量} ${币种} · ${占比}`,
// 原币口径),计入持有、不当异常(探测账户里 USD1 全额锁定)。无锁定 → 无 note。
// 展示数量格式化(千分位,最多 8 位小数)。balance 级 Note 文案用。
const fmtAmount = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

export function parseUnified(coins: BybitCoin[]): Spot[] {
  const out: Spot[] = [];
  for (const c of coins ?? []) {
    const coin = c.coin;
    if (!coin) continue;
    const amount = Number(c.walletBalance ?? 0);
    if (!(amount > 0)) continue;
    const usdValue = Number(c.usdValue ?? 0);
    const row: Spot = {
      symbol: coin,
      amount,
      // 自带美元值反推单价;usdValue=0(小币无价)→ price 省略、value 记 0,交 oracle 兜底。
      price: usdValue > 0 ? usdValue / amount : undefined,
      value: usdValue,
      kind: "spot",
      // 场馆命名:Bybit 管这个币叫 `coin`。symbol 大写归一由本 provider 负责(见 @folio/oracle-ref)。
      tokenRef: tokenRef.issued(PROVIDER_ID, coin.trim().toUpperCase()),
    };
    const locked = Number(c.locked ?? 0);
    if (locked > 0) {
      const pct = amount > 0 ? Math.round((locked / amount) * 100) : 0;
      row.note = {
        title: "Locked",
        icon: "warning",
        content: `${fmtAmount(locked)} ${coin} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

// —— 币价提示表(price hint)——
// 资金账户端点**不自带美元价**。统一账户每币的 usdValue/walletBalance 就是它的市价,抽成一张 ccy→price
// 表**零额外请求**复用:资金账户里**也在统一账户出现或是稳定币**的币能立即估值,其余留 value:0 交 oracle。
export type PriceHint = Record<string, number>;
export function buildPriceHint(coins: BybitCoin[]): PriceHint {
  const hint: PriceHint = {};
  for (const c of coins ?? []) {
    if (!c.coin) continue;
    const amount = Number(c.walletBalance ?? 0);
    const usd = Number(c.usdValue ?? 0);
    if (amount > 0 && usd > 0) hint[c.coin.trim().toUpperCase()] = usd / amount;
  }
  return hint;
}
// 币的美元单价:稳定币≈1,否则查提示表,查不到 → undefined(value 记 0,oracle 回填)。
function priceOf(symbol: string, hint: PriceHint): number | undefined {
  const s = symbol.trim().toUpperCase();
  if (STABLECOINS.has(s)) return 1;
  return hint[s];
}

// 纯解析:资金账户 balance[] → Spot[]。数量取 `walletBalance`;价走提示表(稳定币≈1,否则统一账户市价,
// 无 → value 0 由 oracle 兜底)。每条带 `note.group:"funding"`(不渲染,仅供账户抽屉归 Tab)。
// 跳过空 coin / walletBalance≤0。与 IO 分离,golden test。
export function parseFunding(assets: BybitFundingCoin[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const a of assets ?? []) {
    const coin = a.coin;
    if (!coin) continue;
    const amount = Number(a.walletBalance ?? 0);
    if (!(amount > 0)) continue;
    const price = priceOf(coin, hint);
    out.push({
      symbol: coin,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, coin.trim().toUpperCase()),
      // 资金钱包标记(抽屉按 note.group 分 Tab):group=funding。与 Binance/OKX 一字对齐。
      note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
    });
  }
  return out;
}

// 纯解析:赚币持仓 list[] → Spot[]。数量取 `amount`(总本金)、算 spot、进净值;价走提示表(同 funding)。
// note 标类目(`label`:Flexible / On-chain)+ `group:"earn"`。**不标 APY** —— Bybit 持仓端点无 APR 字段
// (见 BybitEarnPosition 注释)。跳过空 coin / amount≤0(已赎回只剩残值的持仓)。与 IO 分离,golden test。
export function parseEarn(positions: BybitEarnPosition[], label: string, hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const p of positions ?? []) {
    const coin = p.coin;
    if (!coin) continue;
    const amount = Number(p.amount ?? 0);
    if (!(amount > 0)) continue;
    const price = priceOf(coin, hint);
    out.push({
      symbol: coin,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, coin.trim().toUpperCase()),
      note: { title: "Earn", icon: "info", content: label, group: "earn" },
    });
  }
  return out;
}

// 拉的赚币类目 → 展示类目标签。FlexibleSaving = 活期出借、OnChain = 链上赚币。
// 展示金额格式化(带符号 + $ + 千分位,2 位小数)。account 级 Note 文案用。
const fmtSignedUsd = (n: number): string =>
  `${n < 0 ? "-" : "+"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// **这条 Note 只会因「等也没用」的失败出现**(FOL-31):瞬时故障已在 `bestEffortVerdict` 那层
// 升级成整账户失败、交给重试,到不了这里。两句提示分别对应剩下的两种:权限没勾、上游变了形状。
export function bucketFailureNote(failed: { name: string; auth: boolean }[]): Note {
  const names = failed.map((f) => f.name).join(" / ");
  const tail = failed.some((f) => f.auth)
    ? "check the API key's permissions"
    : "couldn't be read this round";
  return { title: "Buckets not synced", icon: "warning", content: `${names} — ${tail}` };
}

// perp 兜底 Note(account 级):统一账户 totalPerpUPL 非零 → 有合约浮盈被排除在 walletBalance 外
// (本轮不解析 perp,ADR 0032 缓做)。用 totalPerpUPL(统一账户响应自带,零额外请求)而非 position/list:
// 它**直接就是被隐藏的那笔浮盈**,正是本 note 的意义;省掉逐 settleCoin 查持仓。
export function perpFallbackNote(uplUsd: number): Note {
  return {
    title: "Futures positions detected",
    icon: "warning",
    content: `Futures uPnL (${fmtSignedUsd(uplUsd)}) isn't in your balance yet — coming when the perp path ships`,
  };
}
