import type { Note, PerpEquity, PerpPosition, Spot } from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { MARGIN_ASSET, PROVIDER_ID, QUOTE_ASSET, QUOTE_SUFFIXES, STABLECOINS } from "./constants";

// 【binance 的适配层:上游形状 → folio 的 `Balance`】——**纯函数,一个都不出网**(ADR 0036)。
//
// 这些函数逐字搬自 `packages/connectors/provider-binance`,fixtures 一个字节没动 ——
// 拆包这一步只挪位置,不改行为,不然「这次同步的数字变了」就分不清是拆包还是解析改的。
//
// 本 connector 会吐的 kind 子集:spot(现货/资金/理财)| perp_equity + perp_position(合约)。
// 判别联合 —— parseFuturesAccount 写错 kind(如 spot)即编译期报错(见 balance.schema 事实源)。
export type BinanceRow = Spot | PerpEquity | PerpPosition;

// @folio/connectors-provider-binance —— 首个带 secret 型 account.creds 的 connector(binance)。
// 每账户密钥(apiKey/secret)走 account.creds(加密入库,取数时由 app 分派桥 openCreds 解密后灌进
// ctx.account.creds)—— 不是全局 provider key。provider 级 creds(PC)不装凭据,只声明 base URL 覆盖
// 的 env key(#264,见 provider.creds)。
// Binance 余额只给数量(free/locked,无 USD)→ 用公开 /ticker/price 按 asset→USDT 自行估值。
// HMAC 只读签名。零依赖,用原生 fetch;不碰 SECRETS_KEY/cloudflare:workers(原则 #5)。

interface BinanceBalance {
  asset?: string;
  free?: string;
  locked?: string;
}
interface BinanceAccount {
  balances?: readonly BinanceBalance[];
}

// 原币数量展示格式化(最多 8 位小数 + 千分位)。仅 note 文案用。
const fmtAmount = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

// 场馆命名者 = connectorId(与 manifest 的 `id` 同源,不许两处各写一遍)。

// 纯解析:account.balances + 价格表(symbol→price)→ Spot[]。与 IO 分离,golden test。
// amount = free + locked;跳过 ≤0;usdValue:稳定币≈1,否则 amount × price(`${asset}USDT`),无对→0。
// 锁仓 note(note 重设计,balance 级单个 Note):locked>0 的币,在【它自己那笔 balance】上挂一个
// `Locked` 段(icon warning;content 一行内联文案 `${锁定数量} ${币种} · ${占该币总持有的百分比}`,
// 如 `1 ETH · 33%`,原币口径不换 USD)。无锁仓 → 无 note。
export function parseAccountBalances(
  account: BinanceAccount,
  prices: Record<string, number>,
): Spot[] {
  const out: Spot[] = [];
  for (const b of account.balances ?? []) {
    const asset = b.asset;
    if (!asset) continue;
    // Binance 现货账户会把**活期理财份额**以 `LD` 前缀混在余额里返回(LDBNB=理财里的 BNB)——那正是
    // earn wallet 用正确 symbol + APY note 专门拉的东西,这里跳过,否则同一笔理财被算两次(净值双算)。
    // `LD` 开头**且长度 > 3**:放过 LDO(Lido,3 字母真币)等短币;理财份额恒是 LD+币名(≥4 字母)。
    if (asset.startsWith("LD") && asset.length > 3) continue;
    const locked = Number(b.locked ?? 0);
    const amount = Number(b.free ?? 0) + locked;
    if (!(amount > 0)) continue;
    const price = STABLECOINS.has(asset) ? 1 : (prices[`${asset}${QUOTE_ASSET}`] ?? undefined);
    const usdValue = price != null ? amount * price : 0;
    const row: Spot = {
      symbol: asset,
      amount,
      price,
      value: usdValue,
      kind: "spot",
      // 场馆命名:币安管这个币叫 `asset`。symbol 大写归一由本 provider 负责(见 @folio/oracle-ref)。
      tokenRef: tokenRef.issued(PROVIDER_ID, asset.trim().toUpperCase()),
    };
    if (locked > 0) {
      const pct = amount > 0 ? Math.round((locked / amount) * 100) : 0;
      row.note = {
        title: "Locked",
        icon: "warning",
        content: `${fmtAmount(locked)} ${asset} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

// —— U 本位合约账户(fapi /fapi/v2/account)的最小形状(仅取用到字段)——
interface FuturesPosition {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  unrealizedProfit?: string;
  leverage?: string;
  notional?: string;
  isolated?: boolean;
  positionInitialMargin?: string;
}
interface FuturesAccount {
  totalMarginBalance?: string; // 账户权益 = 钱包余额 + 未实现盈亏
  totalPositionInitialMargin?: string;
  maxWithdrawAmount?: string;
  positions?: readonly FuturesPosition[];
}

// 合约 symbol 去计价后缀得标的币名(BTCUSDT → BTC);认不出后缀就原样返回。
function coinFromSymbol(symbol: string): string {
  for (const q of QUOTE_SUFFIXES) {
    if (symbol.endsWith(q) && symbol.length > q.length) return symbol.slice(0, -q.length);
  }
  return symbol;
}

// 纯解析:fapi 账户 → perp_equity(账户权益,唯一带值)+ 每个持仓 perp_position(value:0,不双算)。
// 照 hyperliquid 口径(P5.1):权益 = totalMarginBalance(钱包余额 + 未实现盈亏);名义/盈亏进 meta。
// 空账户(无权益、无持仓)→ 空数组(没开合约的用户不冒空行)。强平价不在此响应 → liquidationPx:null
// (主页对 null 有既有降级,显开仓价);杠杆/名义 V2 account 自带。与 IO 分离,golden test。
export function parseFuturesAccount(account: FuturesAccount): (PerpEquity | PerpPosition)[] {
  const positions = (account.positions ?? []).filter((p) => Number(p.positionAmt ?? 0) !== 0);
  const equity = Number(account.totalMarginBalance ?? 0);
  // 无权益且无持仓 → 该合约钱包为空,不产任何行。
  if (!(equity > 0) && positions.length === 0) return [];

  const out: (PerpEquity | PerpPosition)[] = [];
  out.push({
    symbol: MARGIN_ASSET,
    amount: equity,
    value: equity,
    kind: "perp_equity",
    tokenRef: tokenRef.issued(PROVIDER_ID, MARGIN_ASSET),
    meta: {
      withdrawable: Number(account.maxWithdrawAmount ?? 0),
      totalMarginUsed: Number(account.totalPositionInitialMargin ?? 0),
      totalNtlPos: positions.reduce((s, p) => s + Math.abs(Number(p.notional ?? 0)), 0),
    },
  });

  for (const p of positions) {
    const symbol = p.symbol;
    if (!symbol) continue;
    const amt = Number(p.positionAmt ?? 0);
    const coin = coinFromSymbol(symbol);
    out.push({
      symbol: coin,
      amount: amt,
      value: 0, // 仓位不计入总额;价值由权益行承载(不双算)
      kind: "perp_position",
      tokenRef: tokenRef.issued(PROVIDER_ID, coin),
      meta: {
        coin,
        side: amt >= 0 ? "long" : "short",
        entryPx: Number(p.entryPrice ?? 0),
        positionValue: Math.abs(Number(p.notional ?? 0)),
        unrealizedPnl: Number(p.unrealizedProfit ?? 0),
        leverage: p.leverage != null ? Number(p.leverage) : undefined,
        leverageType: p.isolated ? "isolated" : "cross",
        liquidationPx: null, // 强平价不在 account 响应,后续增量(positionRisk)再补
        marginUsed: Number(p.positionInitialMargin ?? 0),
      },
    });
  }
  return out;
}

// —— 币本位合约账户(dapi /dapi/v1/account)的最小形状 ——
interface CoinmAsset {
  asset?: string;
  marginBalance?: string; // per-asset 权益(币计价)
  maxWithdrawAmount?: string;
  positionInitialMargin?: string;
}
interface CoinmPosition {
  symbol?: string;
  positionAmt?: string; // 张数(cont),非币量
  entryPrice?: string;
  unrealizedProfit?: string; // 币计价
  leverage?: string;
  notional?: string; // 币计价
  isolated?: boolean;
  positionInitialMargin?: string;
}
interface CoinmAccount {
  assets?: readonly CoinmAsset[];
  positions?: readonly CoinmPosition[];
}

// 币本位 symbol 去尾得标的币名(BTCUSD_PERP / BTCUSD_251226 → BTC):取 `_` 前段再剥 USD。
function coinmCoin(symbol: string): string {
  const base = symbol.split("_")[0];
  return base.endsWith("USD") && base.length > 3 ? base.slice(0, -3) : base;
}

// 纯解析:dapi 账户 → perp_equity(折 USD 聚合成**一行**,与 U 本位/hyperliquid 同构)+ 持仓 perp_position。
// 币本位无单一 USD 总权益 —— 各币 marginBalance / notional / 盈亏都按行情(prices)折 USD 再合。
// 认不出价的币(prices 无该对)→ 折 0(该币权益暂计 0,下轮有价再算)。**持仓 amount 是张数(cont)**,非币量。
// 强平价不在此响应 → liquidationPx:null(主页降级显开仓价)。与 IO 分离,golden test。
export function parseCoinmFuturesAccount(
  account: CoinmAccount,
  prices: Record<string, number>,
): (PerpEquity | PerpPosition)[] {
  const priceOf = (coin: string) =>
    STABLECOINS.has(coin) ? 1 : (prices[`${coin}${QUOTE_ASSET}`] ?? 0);

  let equityUsd = 0;
  let withdrawableUsd = 0;
  let marginUsedUsd = 0;
  for (const a of account.assets ?? []) {
    if (!a.asset) continue;
    const px = priceOf(a.asset);
    equityUsd += Number(a.marginBalance ?? 0) * px;
    withdrawableUsd += Number(a.maxWithdrawAmount ?? 0) * px;
    marginUsedUsd += Number(a.positionInitialMargin ?? 0) * px;
  }

  const positions = (account.positions ?? []).filter((p) => Number(p.positionAmt ?? 0) !== 0);
  if (!(equityUsd > 0) && positions.length === 0) return [];

  const posRows: PerpPosition[] = [];
  let totalNtlPos = 0;
  for (const p of positions) {
    if (!p.symbol) continue;
    const coin = coinmCoin(p.symbol);
    const px = priceOf(coin);
    const notionalUsd = Math.abs(Number(p.notional ?? 0)) * px;
    totalNtlPos += notionalUsd;
    const amt = Number(p.positionAmt ?? 0);
    posRows.push({
      symbol: coin,
      amount: amt,
      value: 0,
      kind: "perp_position",
      tokenRef: tokenRef.issued(PROVIDER_ID, coin),
      meta: {
        coin,
        side: amt >= 0 ? "long" : "short",
        entryPx: Number(p.entryPrice ?? 0),
        positionValue: notionalUsd,
        unrealizedPnl: Number(p.unrealizedProfit ?? 0) * px,
        leverage: p.leverage != null ? Number(p.leverage) : undefined,
        leverageType: p.isolated ? "isolated" : "cross",
        liquidationPx: null,
        marginUsed: Number(p.positionInitialMargin ?? 0) * px,
      },
    });
  }

  return [
    {
      symbol: MARGIN_ASSET,
      amount: equityUsd,
      value: equityUsd,
      kind: "perp_equity",
      tokenRef: tokenRef.issued(PROVIDER_ID, MARGIN_ASSET),
      meta: { withdrawable: withdrawableUsd, totalMarginUsed: marginUsedUsd, totalNtlPos },
    },
    ...posRows,
  ];
}

// —— 资金账户(Funding)的最小形状 ——
interface FundingAsset {
  asset?: string;
  free?: string;
  locked?: string;
  freeze?: string;
  withdrawing?: string;
}

// 纯解析:资金账户资产 → spot。free+locked+freeze+withdrawing 合并为持有量,ticker 估值(同现货)。
// 跳过零余额;无价的币 value 0(price 省略)。与 IO 分离,golden test。
export function parseFundingAssets(
  assets: readonly FundingAsset[],
  prices: Record<string, number>,
): Spot[] {
  const out: Spot[] = [];
  for (const a of assets ?? []) {
    const asset = a.asset;
    if (!asset) continue;
    const amount =
      Number(a.free ?? 0) +
      Number(a.locked ?? 0) +
      Number(a.freeze ?? 0) +
      Number(a.withdrawing ?? 0);
    if (!(amount > 0)) continue;
    const price = STABLECOINS.has(asset) ? 1 : (prices[`${asset}${QUOTE_ASSET}`] ?? undefined);
    out.push({
      symbol: asset,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, asset.trim().toUpperCase()),
      // 资金钱包标记(抽屉按 note.group 分 tab):group=funding。
      note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
    });
  }
  return out;
}

// —— 理财(Simple Earn)的最小形状 ——
interface EarnFlexibleRow {
  asset?: string;
  totalAmount?: string;
  latestAnnualPercentageRate?: string; // 活期浮动 APY(小数,如 "0.05")
}
interface EarnLockedRow {
  asset?: string;
  amount?: string;
  apy?: string; // 定期 APY(小数)
  redeemDate?: number | string; // 到期(ms 时间戳)
}
interface EarnFlexible {
  rows?: readonly EarnFlexibleRow[];
}
interface EarnLocked {
  rows?: readonly EarnLockedRow[];
}

// APY 小数 → 百分比串("0.05" → "5.00%")。
const apyPct = (rate: string | number | undefined): string =>
  `${(Number(rate ?? 0) * 100).toFixed(2)}%`;
// 到期 ms → MM/DD(UTC,避开时区);非法/缺失 → 空串。
function mmdd(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

// 纯解析:活期 + 定期理财 → spot(ticker 估值,同现货)+ balance 级 note(APY / 锁定期,info 语气)。
// 同一个币活期定期各一行 → 各自成行(聚合层按 token_id 合并);锁定的币照常计入净值。golden test。
export function parseEarnPositions(
  flexible: EarnFlexible,
  locked: EarnLocked,
  prices: Record<string, number>,
): Spot[] {
  const out: Spot[] = [];
  const add = (asset: string | undefined, amount: number, note: Note) => {
    if (!asset || !(amount > 0)) return;
    const price = STABLECOINS.has(asset) ? 1 : (prices[`${asset}${QUOTE_ASSET}`] ?? undefined);
    out.push({
      symbol: asset,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, asset.trim().toUpperCase()),
      note,
    });
  };
  for (const r of flexible.rows ?? []) {
    add(r.asset, Number(r.totalAmount ?? 0), {
      title: "Earn",
      icon: "info",
      content: `Flexible · ${apyPct(r.latestAnnualPercentageRate)} APY`,
      group: "earn",
    });
  }
  for (const r of locked.rows ?? []) {
    const dd = r.redeemDate != null ? mmdd(Number(r.redeemDate)) : "";
    add(r.asset, Number(r.amount ?? 0), {
      title: "Earn",
      icon: "info",
      content: `Locked${dd ? ` until ${dd}` : ""} · ${apyPct(r.apy)} APY`,
      group: "earn",
    });
  }
  return out;
}
