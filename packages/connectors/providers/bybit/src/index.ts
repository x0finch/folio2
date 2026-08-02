import {
  type BalanceProvider,
  type CredField,
  hmacSha256,
  isCredentialRejection,
  ProviderError,
  type Spot,
} from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { createHttpClient } from "@folio/shared";
import { z } from "zod";
import {
  AUTH_ERROR_CODES,
  BYBIT_API_BASE,
  FUNDING_BALANCES_PATH,
  HEADER_KEY,
  HEADER_RECV_WINDOW,
  HEADER_SIGN,
  HEADER_SIGN_TYPE,
  HEADER_TIMESTAMP,
  RECV_WINDOW,
  STABLECOINS,
  WALLET_BALANCE_PATH,
} from "./constants";

// @folio/connectors-provider-bybit —— 第三个 CEX connector(bybit)。与 OKX 同构:统一账户(UTA)+
// 资金账户 + Earn。与 binance/okx 的差异:① 签名是 hex(HMAC(timestamp+apiKey+recvWindow+queryString));
// ② creds 只有 apiKey/secret(**无 passphrase**);③ 统一账户自带每币 usdValue(零额外请求估值);
// ④ 错误以 HTTP 200 + retCode(**数字** 0=OK)返回。每账户密钥走 account.creds(加密入库,取数时由
// 分派桥 openCreds 解密后灌入 ctx.account.creds)。原生 fetch,零依赖。依据 ADR 0032。

// 统一账户 /v5/account/wallet-balance 的每币最小形状(仅取用到字段)。
interface BybitCoin {
  coin?: string;
  walletBalance?: string; // 现金余额(不含合约 uPnL)—— 持有量口径(ADR 0032)
  equity?: string; // = walletBalance + unrealisedPnl(作保证金时含合约浮盈)—— **不当持有量**
  usdValue?: string; // Bybit 自带的美元值 —— 估值口径,零额外请求
  locked?: string; // 被订单/产品锁定的量(含在 walletBalance 里)
}
interface BybitWalletBalanceResponse {
  retCode?: number; // Bybit 的 retCode 是**数字**(0=OK),异于 OKX 的字符串 code
  retMsg?: string;
  result?: { list?: Array<{ accountType?: string; totalEquity?: string; coin?: BybitCoin[] }> };
}

// 资金账户 /v5/asset/transfer/query-account-coins-balance?accountType=FUND 的最小形状。
interface BybitFundingCoin {
  coin?: string;
  walletBalance?: string; // 总余额 —— 持有量口径
}
interface BybitFundingResponse {
  retCode?: number;
  retMsg?: string;
  result?: { balance?: BybitFundingCoin[] };
}

// 原币数量展示格式化(最多 8 位小数 + 千分位)。仅 note 文案用。
const fmtAmount = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

// 场馆命名者 = connectorId(与 manifest 的 `id` 同源,不许两处各写一遍)。
const PROVIDER_ID = "bybit";

// 纯解析:统一账户 coin[] → Spot[]。与 IO 分离,golden test。
// amount=walletBalance(现金,不含 uPnL —— ADR 0032;**不用 equity**,它含合约浮盈)、value=usdValue
// (Bybit 自带,零额外请求)、price=usdValue/amount(反推单价);跳过空 coin / walletBalance≤0;kind:spot。
// locked>0 的币在【它自己那笔 balance】挂一个 `Locked` 段(icon warning;`${锁定量} ${币种} · ${占比}`,
// 原币口径),计入持有、不当异常(探测账户里 USD1 全额锁定)。无锁定 → 无 note。
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

// 出网:签名头 + 失败归类走共享的 http 包装(@folio/shared)。**没有限频器** —— 额度按账户自己那把
// key 算、一次同步端点数固定不并挤,装了拦不到任何东西。
//
// Bybit v5 签名:`X-BAPI-SIGN = hex(HMAC-SHA256(secret, timestamp + apiKey + recvWindow + queryString))`。
// queryString 必须与实际发送的**一字不差** —— 用与 http 客户端同样的 URLSearchParams.set 顺序重建。
type BybitCreds = { apiKey: string; secret: string };

// —— base URL 覆盖(#264)——
// 远程(CF Workers)出口 IP 被 Bybit 按地区拒时,由 app 层从 env 注入代理 base;不设即原样直连。
// connector 不读 env、不知代理存在(原则 #5):只把 ctx.creds.BYBIT_API_BASE 当**不透明整串**用,缺省回退默认。
const BYBIT_BASE_KEY = "BYBIT_API_BASE";
function pickBybitBase(cfg: Record<string, unknown>): string {
  const v = cfg[BYBIT_BASE_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : BYBIT_API_BASE;
}

// 请求 client 工厂:base 按请求可覆盖,故不模块级绑死单例。
const makeRequest = (baseUrl: string) =>
  createHttpClient<BybitCreds>({
    baseUrl,
    headers: async (_path, options) => {
      const creds = options?.context;
      if (!creds) throw new ProviderError("INVALID_CREDENTIALS", "bybit: missing credentials");
      // 与 http.ts 的 URL query 构造同样的顺序/编码(URLSearchParams.set) → 被签串与发送的一字不差。
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(options?.query ?? {})) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const ts = Date.now().toString();
      const sign = await hmacSha256(
        creds.secret,
        ts + creds.apiKey + RECV_WINDOW + qs.toString(),
        "hex",
      );
      return {
        [HEADER_KEY]: creds.apiKey,
        [HEADER_TIMESTAMP]: ts,
        [HEADER_RECV_WINDOW]: RECV_WINDOW,
        [HEADER_SIGN]: sign,
        [HEADER_SIGN_TYPE]: "2",
      };
    },
    // Bybit 的业务错误是 HTTP 200 + retCode(见 assertRetCodeOk),这里只管 HTTP 层。
    toFailure: ({ kind, where, status, retryAfterMs, cause }) => {
      if (kind === "network")
        return new ProviderError("UPSTREAM_ERROR", "bybit request failed", { cause });
      if (kind === "auth") return new ProviderError("AUTH_FAILED", `bybit auth failed (${status})`);
      if (kind === "rate-limited")
        return new ProviderError("RATE_LIMITED", "bybit rate limited", { retryAfterMs });
      if (kind === "parse")
        return new ProviderError("PARSE_ERROR", `bybit returned invalid JSON (${where})`, {
          cause,
        });
      return new ProviderError("UPSTREAM_ERROR", `bybit upstream error (${status})`);
    },
  });

// 业务层错误(HTTP 200 + retCode!=0):凭据类 retCode → AUTH_FAILED,其余 → UPSTREAM_ERROR。
// retCode 是数字(0=OK)。返回错误对象(不抛)—— 后续片逐桶尽力而为时需要「拿到错误但不中断」。
function retCodeError(body: { retCode?: number; retMsg?: string }): ProviderError | undefined {
  if (body.retCode === 0) return undefined;
  const code = body.retCode ?? -1;
  const msg = body.retMsg || "bybit error";
  return AUTH_ERROR_CODES.has(code)
    ? new ProviderError("AUTH_FAILED", `bybit auth failed (retCode ${code}: ${msg})`)
    : new ProviderError("UPSTREAM_ERROR", `bybit error (retCode ${code}: ${msg})`);
}
function assertRetCodeOk(body: { retCode?: number; retMsg?: string }): void {
  const err = retCodeError(body);
  if (err) throw err;
}

// —— 账户级 creds(AC):apiKey(semi)/secret(secret)。**无 passphrase**(异于 OKX)。apiKey = 标识符
// (明文走 header,非认证秘密)→ semi;secret = 签名秘密 → secret。——
export const bybitAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

export const bybitProvider: BalanceProvider<Spot, typeof bybitAccountCreds> = {
  id: PROVIDER_ID,
  label: "Bybit",
  // 无全局 provider key —— 账户自己的 apiKey/secret 即凭据,走 account.creds。
  // PC 在此仅作 **env 注入声明**(非真凭据):app 层据此 key 从 env 读值灌进 ctx.creds,供 base URL
  // 覆盖(#264)。不进 UI 表单(那只认 account.creds)、不加密/不导出;值可能含代理密钥 → 不可 echo/log。
  creds: [
    {
      key: BYBIT_BASE_KEY,
      type: "public",
      label: "API base URL",
      validator: z.string().trim().url(),
    },
  ],

  async fetchBalances(ctx): Promise<{ balances: Spot[] }> {
    const request = makeRequest(pickBybitBase(ctx.creds as Record<string, unknown>));
    const creds = ctx.account.creds;
    // 各桶用**同一把 key 并发**拉,合并成一份余额(ADR 0032)。本片接入统一账户(UNIFIED)+ 资金账户(FUND)。
    // 用 allSettled 而非 all:**等齐所有请求**再决定,避免某端点先失败时,并发的兄弟请求(异步签名仍在飞)
    // 漏到调用结束后才 fetch(fire-and-forget → 泄漏到下轮 / 污染测试 spy)。本片语义仍是「任一端点失败即
    // 整次失败」(抛第一个错、下轮重试,不拿半份快照覆盖);逐桶「尽力而为」留片 4 把这里的 throw 换成收 Note。
    const settled = await Promise.allSettled([
      request(WALLET_BALANCE_PATH, { context: creds, query: { accountType: "UNIFIED" } }),
      request(FUNDING_BALANCES_PATH, { context: creds, query: { accountType: "FUND" } }),
    ]);
    const firstRejected = settled.find((r) => r.status === "rejected");
    if (firstRejected) throw (firstRejected as PromiseRejectedResult).reason;
    const [unifiedBody, fundingBody] = settled.map(
      (r) => (r as PromiseFulfilledResult<unknown>).value,
    ) as [BybitWalletBalanceResponse, BybitFundingResponse];
    // HTTP 200 + retCode!=0 是 Bybit 表达错误的主要方式,包管不到这一层。
    assertRetCodeOk(unifiedBody);
    assertRetCodeOk(fundingBody);

    const coins = unifiedBody.result?.list?.[0]?.coin ?? [];
    // 统一账户市价表复用给资金账户估值(零额外请求,见 buildPriceHint)。
    const hint = buildPriceHint(coins);
    return {
      balances: [...parseUnified(coins), ...parseFunding(fundingBody.result?.balance ?? [], hint)],
    };
  },

  // 校验:签名打统一账户余额确认 key + 读权限(creds 已由 validateCredentials 保证非空)。
  // 凭据被拒 → false;够不到上游 → 抛(契约见 connector.ts / errors.ts)。
  async validateAccount(ctx): Promise<boolean> {
    const request = makeRequest(pickBybitBase(ctx.creds as Record<string, unknown>));
    try {
      const body = (await request(WALLET_BALANCE_PATH, {
        context: ctx.account.creds,
        query: { accountType: "UNIFIED" },
      })) as BybitWalletBalanceResponse;
      assertRetCodeOk(body);
      return true;
    } catch (err) {
      if (isCredentialRejection(err)) return false;
      throw err;
    }
  },
};
