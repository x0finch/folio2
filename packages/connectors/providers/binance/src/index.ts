import {
  type BalanceProvider,
  type CredField,
  hmacSha256,
  isCredentialRejection,
  type Note,
  type PerpEquity,
  type PerpPosition,
  ProviderError,
  type Spot,
} from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { createHttpClient, defineRateLimit, type Failure } from "@folio/shared";
import { z } from "zod";
import {
  ACCOUNT_PATH,
  API_KEY_HEADER,
  BINANCE_API_BASE,
  BINANCE_DELIVERY_API_BASE,
  BINANCE_FUTURES_API_BASE,
  COINM_ACCOUNT_PATH,
  MARGIN_ASSET,
  PUBLIC_LIMIT_KEY,
  QUOTE_ASSET,
  QUOTE_SUFFIXES,
  RECV_WINDOW,
  STABLECOINS,
  TICKER_PRICE_PATH,
  TICKER_RATE_LIMIT_BURST,
  TICKER_RATE_LIMIT_PER_SEC,
  USDM_ACCOUNT_PATH,
} from "./constants";

// 本 connector 会吐的 kind 子集:spot(现货/资金/理财)| perp_equity + perp_position(合约)。
// 判别联合 —— parseFuturesAccount 写错 kind(如 spot)即编译期报错(见 balance.schema 事实源)。
type BinanceRow = Spot | PerpEquity | PerpPosition;

// @folio/connectors-provider-binance —— 首个带 secret 型 account.creds 的 connector(binance)。
// 每账户密钥(apiKey/secret)走 account.creds(加密入库,取数时由 app 分派桥 openCreds 解密后灌进
// ctx.account.creds)—— 不是全局 provider key,故 provider 级 creds(PC)为空。
// Binance 余额只给数量(free/locked,无 USD)→ 用公开 /ticker/price 按 asset→USDT 自行估值。
// HMAC 只读签名。零依赖,用原生 fetch;不碰 SECRETS_KEY/cloudflare:workers(原则 #5)。

interface BinanceBalance {
  asset?: string;
  free?: string;
  locked?: string;
}
interface BinanceAccount {
  balances?: BinanceBalance[];
}
interface TickerPrice {
  symbol?: string;
  price?: string;
}

// 原币数量展示格式化(最多 8 位小数 + 千分位)。仅 note 文案用。
const fmtAmount = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

// 场馆命名者 = connectorId(与 manifest 的 `id` 同源,不许两处各写一遍)。
const PROVIDER_ID = "binance";

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
  positions?: FuturesPosition[];
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
  assets?: CoinmAsset[];
  positions?: CoinmPosition[];
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

// 公开(免签)端点的限频器 —— 按出口 IP 共享,见 constants.ts 里为什么只给它装。
const publicLimit = defineRateLimit({
  key: PUBLIC_LIMIT_KEY,
  limit: TICKER_RATE_LIMIT_BURST,
  interval: (TICKER_RATE_LIMIT_BURST / TICKER_RATE_LIMIT_PER_SEC) * 1000,
});

// **两个 client,因为是两份额度。** 公开端点按出口 IP 算(所有账户所有用户共花一份)→ 过闸;
// 签名端点按账户自己那把 key 算、每账户只发一次不并发 → 装闸拦不到任何东西,刻意不装。
// 归类规则两边一样,所以抽出来共用。
const toFailure = ({ kind, where, status, retryAfterMs, cause }: Failure): Error => {
  if (kind === "network")
    return new ProviderError("UPSTREAM_ERROR", "binance request failed", { cause });
  if (kind === "auth") return new ProviderError("AUTH_FAILED", `binance auth failed (${status})`);
  // **binance 用 HTTP 400 表达「这份签名请求被拒」** —— 最常见的是错 secret(签名对不上,-1022)
  // 或 key 格式非法(-2014)。它们是凭据问题、非传输故障:重试没用,还会拿着错凭据再打一次上游
  // (binance 会把重复认证失败当探测行为,见 #240)。故 400 → AUTH_FAILED(不可重试;validateAccount
  // 据此返回 false)。极少数非凭据 400(如 -1021 时钟偏移)也归此 —— 同样非瞬时,且与旧行为一致。
  if (status === 400) return new ProviderError("AUTH_FAILED", "binance rejected request (400)");
  // 418 = 收到 429 还继续打换来的封 IP,和限流同类处理。
  if (kind === "rate-limited")
    return new ProviderError("RATE_LIMITED", `binance rate limited (${status})`, { retryAfterMs });
  if (kind === "parse")
    return new ProviderError("PARSE_ERROR", `binance returned invalid JSON (${where})`, { cause });
  return new ProviderError("UPSTREAM_ERROR", `binance upstream error (${status})`);
};

const publicRequest = createHttpClient({
  baseUrl: BINANCE_API_BASE,
  limit: publicLimit,
  rateLimitedStatuses: [429, 418],
  toFailure,
});

// 签名端点 client 工厂 —— 现货(api.binance.com)与合约(fapi.binance.com)是两份不同 host、
// 同样的签名头 + 失败归类。多钱包骨架的第一处「多 host」:后续币本位(dapi)再加一个即可。
const makeSignedClient = (baseUrl: string) =>
  createHttpClient<string>({
    baseUrl,
    rateLimitedStatuses: [429, 418],
    headers: (_path, options) => ({ [API_KEY_HEADER]: options?.context ?? "" }),
    toFailure,
  });

const signedRequest = makeSignedClient(BINANCE_API_BASE);
const fapiSignedRequest = makeSignedClient(BINANCE_FUTURES_API_BASE);
const dapiSignedRequest = makeSignedClient(BINANCE_DELIVERY_API_BASE);

// 签名拉取 SIGNED 端点。**签名算的是「除 signature 外、按发送顺序拼起来的 query」**,
// 所以这里先按同样的顺序拼一遍来签,再把 signature 追加到最后 —— URLSearchParams 保持插入序,
// 两边一致。client 决定打哪个 host(现货 signedRequest / 合约 fapiSignedRequest)。
async function signedGet(
  client: ReturnType<typeof makeSignedClient>,
  path: string,
  params: Record<string, string | number>,
  apiKey: string,
  secret: string,
): Promise<unknown> {
  const signature = await hmacSha256(
    secret,
    new URLSearchParams(params as never).toString(),
    "hex",
  );
  return client(path, { query: { ...params, signature }, context: apiKey });
}

// —— 账户级 creds(AC):apiKey/secret。apiKey = 标识符(明文走 header,非认证秘密)→ semi:
// 导出打码保留供补录识别;secret = 签名密钥 → secret:导出剥离。账户 creds 声明随 provider(其天然
// 消费者)落此;将来同 connector 多 provider 时提到 entry 共享。——
export const binanceAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// —— 多钱包骨架(ADR 0030)——
// 一个 Binance 账户 = 多个隔离**钱包**(现货 / 合约 / 资金 / 理财…),同一把 key 并发拉。
// 尽力而为:某钱包失败不阻断其余,失败收集成一条**账户级 Note** 提示。凭据类失败(AUTH_FAILED,如没勾
// Futures 的 -2015)与瞬时故障(超时/5xx)都降级为「该钱包失败」,不冒泡成整账户失败。
interface Wallet {
  name: string; // 展示名(失败时列进 Note)
  // prices 传 **Promise** 而非值:价表(公开、带闸)与各钱包(签名、无闸)**并发**发起 —— 合约不需要价表、
  // 现货内部 await 它。否则价表的闸会前置阻塞签名端点的并发,限流时拖垮整批同步(rate-limit test)。
  run: (
    creds: { apiKey: string; secret: string },
    prices: Promise<Record<string, number>>,
  ) => Promise<BinanceRow[]>;
}

// 现货钱包:签名 /api/v3/account(立即发,无闸),再 await 价表估值。
const spotWallet: Wallet = {
  name: "Spot",
  run: async ({ apiKey, secret }, prices) => {
    const account = (await signedGet(
      signedRequest,
      ACCOUNT_PATH,
      { recvWindow: RECV_WINDOW, timestamp: Date.now() },
      apiKey,
      secret,
    )) as BinanceAccount;
    return parseAccountBalances(account, await prices);
  },
};

// U 本位合约钱包:签名 fapi /fapi/v2/account(**独立 host**),一发拿权益 + 持仓。合约自带 USD,不用价表。
const usdmFuturesWallet: Wallet = {
  name: "USDⓈ-M Futures",
  run: async ({ apiKey, secret }) => {
    const account = (await signedGet(
      fapiSignedRequest,
      USDM_ACCOUNT_PATH,
      { recvWindow: RECV_WINDOW, timestamp: Date.now() },
      apiKey,
      secret,
    )) as FuturesAccount;
    return parseFuturesAccount(account);
  },
};

// 币本位合约钱包:签名 dapi /dapi/v1/account(**又一个独立 host**);权益折 USD 需价表 → await prices。
const coinmFuturesWallet: Wallet = {
  name: "COIN-M Futures",
  run: async ({ apiKey, secret }, prices) => {
    const account = (await signedGet(
      dapiSignedRequest,
      COINM_ACCOUNT_PATH,
      { recvWindow: RECV_WINDOW, timestamp: Date.now() },
      apiKey,
      secret,
    )) as CoinmAccount;
    return parseCoinmFuturesAccount(account, await prices);
  },
};

// 本 provider 当前拉的钱包集 —— 后续片(资金 / 理财)往这里加一项即可。
const WALLETS: Wallet[] = [spotWallet, usdmFuturesWallet, coinmFuturesWallet];

// 账户级失败 Note(ADR 0030):列出没同步上的钱包 + 一句提示。
function walletFailureNote(failed: string[]): Note {
  return {
    title: "Wallets not synced",
    icon: "warning",
    content: `${failed.join(" / ")} · 检查该钱包的 API 权限(合约需勾 Futures)或稍后重试`,
  };
}

export const binanceProvider: BalanceProvider<BinanceRow, typeof binanceAccountCreds> = {
  id: PROVIDER_ID,
  label: "Binance",
  // 无全局 provider key —— 账户自己的 apiKey/secret 即凭据,走 account.creds。
  creds: [],

  async fetchBalances(ctx): Promise<{ balances: BinanceRow[]; note?: Note[] }> {
    const { apiKey, secret } = ctx.account.creds;
    // 公开免签价表(现货/资金/理财估值共用),带闸(按出口 IP)。启动但**不前置阻塞**钱包并发:合约不需要它,
    // 现货内部 await;价表失败 → 现货那个钱包失败(进 Note),不拖垮不需要它的合约。
    const prices = (async () => {
      const tickers = (await publicRequest(TICKER_PRICE_PATH)) as TickerPrice[];
      const map: Record<string, number> = {};
      for (const t of tickers) if (t.symbol) map[t.symbol] = Number(t.price ?? 0);
      return map;
    })();
    void prices.catch(() => {}); // 某钱包在 await 价表前就失败时,价表无人 await → 防 unhandled rejection
    // 各钱包并发,尽力而为(ADR 0030):成功的进 balances,失败的收进账户级 Note。
    const settled = await Promise.allSettled(WALLETS.map((w) => w.run({ apiKey, secret }, prices)));
    const balances: BinanceRow[] = [];
    const failed: string[] = [];
    let firstError: unknown;
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") balances.push(...r.value);
      else {
        failed.push(WALLETS[i].name);
        firstError ??= r.reason;
      }
    });
    // **全军覆没**(无一钱包成功,如 429 限流所有端点)→ 抛,让 sync 重试、别拿空快照覆盖已有余额。
    // 只有**部分**失败才走尽力而为(收 Note、返回成功的那些)。
    if (failed.length === WALLETS.length && firstError) throw firstError;
    return { balances, note: failed.length ? [walletFailureNote(failed)] : undefined };
  },

  // 校验:签名打现货 /api/v3/account 确认 key + 读权限(creds 已由 validateCredentials 保证非空)。
  // 只验现货(基础读权限)—— 部分授权(如没勾 Futures)是同步期尽力而为的事,不该卡住加账户。
  // 凭据被拒(-2014/-2015 等 → AUTH_FAILED)→ false;够不到上游 → 抛(契约见 connector.ts / errors.ts)。
  async validateAccount(ctx): Promise<boolean> {
    const { apiKey, secret } = ctx.account.creds;
    try {
      await signedGet(
        signedRequest,
        ACCOUNT_PATH,
        { recvWindow: RECV_WINDOW, timestamp: Date.now() },
        apiKey,
        secret,
      );
      return true;
    } catch (err) {
      if (isCredentialRejection(err)) return false;
      throw err;
    }
  },
};
