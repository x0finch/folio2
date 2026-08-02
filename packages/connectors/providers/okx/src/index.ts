import {
  type BalanceProvider,
  type CredField,
  hmacSha256,
  isCredentialRejection,
  type Note,
  ProviderError,
  type Spot,
} from "@folio/connectors-basic";
import { tokenRef } from "@folio/oracle-ref";
import { createHttpClient } from "@folio/shared";
import { z } from "zod";
import {
  ASSET_VALUATION_PATH,
  AUTH_ERROR_CODES,
  BALANCE_PATH,
  EARN_RESIDUAL_MIN_USD,
  FUNDING_BALANCES_PATH,
  HEADER_KEY,
  HEADER_PASSPHRASE,
  HEADER_SIGN,
  HEADER_TIMESTAMP,
  OKX_API_BASE,
  SAVINGS_BALANCE_PATH,
  STABLECOINS,
  STAKING_ORDERS_ACTIVE_PATH,
} from "./constants";

// @folio/connectors-provider-okx —— 第二个 CEX connector(okx)。复用 @folio/connectors-basic 的 hmacSha256。
// 与 binance 的差异:① 签名是 base64(HMAC(timestamp+METHOD+requestPath, secret));② 需 passphrase;
// ③ 余额自带 eqUsd(无需公开价估值);④ 错误常以 HTTP 200 + code!="0" 返回(含 key/签名错)。
// 每账户密钥(apiKey/secret/passphrase)走 account.creds(加密入库,取数时由分派桥 openCreds 解密后灌入
// ctx.account.creds)—— 不是全局 provider key。provider 级 creds(PC)不装凭据,只声明 base URL 覆盖
// 的 env key(#264,见 provider.creds)。原生 fetch,零依赖。

interface OkxDetail {
  ccy?: string;
  eq?: string; // 币权益(统一账户里作保证金时含合约 uPnL)—— 只用来折市价,不当持有量
  eqUsd?: string; // eq 的美元值 —— 与 eq 同比例,eqUsd/eq = 市价(不含 uPnL)
  cashBal?: string; // 现金余额(不含合约 uPnL)—— 持有量口径,修 #259
  frozenBal?: string; // 冻结余额(原币,挂单/借贷占用)
}
interface OkxBalanceResponse {
  code?: string;
  msg?: string;
  data?: Array<{ details?: OkxDetail[] }>;
}

// 资金账户(funding 桶)/asset/balances 的最小形状 —— data 是扁平数组(非 details 包裹)。
interface OkxFundingAsset {
  ccy?: string;
  bal?: string; // 总余额(含冻结)—— 持有量口径
}
interface OkxFundingResponse {
  code?: string;
  msg?: string;
  data?: OkxFundingAsset[];
}

// 原币数量展示格式化(最多 8 位小数 + 千分位)。仅 note 文案用。
const fmtAmount = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 8 });

// 纯解析:details[] → Spot[]。与 IO 分离,golden test。
// 场馆命名者 = connectorId(与 manifest 的 `id` 同源,不许两处各写一遍)。
const PROVIDER_ID = "okx";

// amount=cashBal(现金,不含合约 uPnL —— 修 #259)、price=eqUsd/eq(市价)、value=amount×price;
// 跳过空 ccy / amount≤0;kind:spot。用 cashBal 而非 eq:统一账户里作合约保证金的币,其 eq 含合约
// 未实现盈亏,拿 eq 当持有量会把没落袋的浮盈算成现货(合约浮盈本轮走 perp,缓做,见 ADR 0031)。
// eqUsd 是 eq 的美元值,eqUsd/eq 得市价(与 uPnL 无关),再 × cashBal 得纯现货美元值。
// 冻结 note(note 重设计,balance 级单个 Note):frozenBal>0 的币,在【它自己那笔 balance】上挂一个
// `Frozen` 段(icon warning;content 一行内联文案 `${冻结数量} ${币种} · ${占该币总持有的百分比}`,
// 如 `0.5 ETH · 25%`,原币口径)。无冻结 → 无 note。
export function parseBalances(details: OkxDetail[]): Spot[] {
  const out: Spot[] = [];
  for (const d of details ?? []) {
    const ccy = d.ccy;
    if (!ccy) continue;
    const amount = Number(d.cashBal ?? 0);
    if (!(amount > 0)) continue;
    const eq = Number(d.eq ?? 0);
    const price = eq > 0 ? Number(d.eqUsd ?? 0) / eq : 0; // 市价;eq=0 无从折价 → 0(交 oracle 兜底)
    const frozen = Number(d.frozenBal ?? 0);
    const row: Spot = {
      symbol: ccy,
      amount,
      price,
      value: amount * price,
      kind: "spot",
      // 场馆命名:OKX 管这个币叫 `ccy`。symbol 大写归一由本 provider 负责(见 @folio/oracle-ref)。
      tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
    };
    if (frozen > 0) {
      const pct = amount > 0 ? Math.round((frozen / amount) * 100) : 0;
      row.note = {
        title: "Frozen",
        icon: "warning",
        content: `${fmtAmount(frozen)} ${ccy} · ${pct}%`,
      };
    }
    out.push(row);
  }
  return out;
}

// —— 币价提示表(price hint)——
// 其余桶(资金 / 赚币)的端点**不自带美元价**;ADR 0031 弃用额外 ticker 端点。交易账户 details 里
// 每个币的 eqUsd/eq 就是它的市价(与 uPnL 无关),把它抽成一张 ccy→price 表**零额外请求**复用:
// 资金/赚币里**也在交易账户出现或是稳定币**的币能立即估值,其余留 value:0 交 oracle 兜底。
export type PriceHint = Record<string, number>;
export function buildPriceHint(details: OkxDetail[]): PriceHint {
  const hint: PriceHint = {};
  for (const d of details ?? []) {
    if (!d.ccy) continue;
    const eq = Number(d.eq ?? 0);
    const px = eq > 0 ? Number(d.eqUsd ?? 0) / eq : 0;
    if (px > 0) hint[d.ccy.trim().toUpperCase()] = px;
  }
  return hint;
}
// 币的美元单价:稳定币≈1,否则查提示表,查不到 → undefined(value 记 0,oracle 回填)。
function priceOf(symbol: string, hint: PriceHint): number | undefined {
  const s = symbol.trim().toUpperCase();
  if (STABLECOINS.has(s)) return 1;
  return hint[s];
}

// 纯解析:资金账户 assets[] → Spot[]。数量取 `bal`(含冻结);价走提示表(稳定币≈1,否则交易账户市价,
// 无 → value 0 由 oracle 兜底)。每条带 `note.group:"funding"`(不渲染,仅供账户抽屉归 Tab,复用
// Binance 的 Note.group 机制)。跳过空 ccy / bal≤0。与 IO 分离,golden test。
export function parseFunding(assets: OkxFundingAsset[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const a of assets ?? []) {
    const ccy = a.ccy;
    if (!ccy) continue;
    const amount = Number(a.bal ?? 0);
    if (!(amount > 0)) continue;
    const price = priceOf(ccy, hint);
    out.push({
      symbol: ccy,
      amount,
      price,
      value: price != null ? amount * price : 0,
      kind: "spot",
      tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
      // 资金钱包标记(抽屉按 note.group 分 Tab):group=funding。与 Binance 一字对齐。
      note: { title: "Funding", icon: "info", content: "Funding wallet", group: "funding" },
    });
  }
  return out;
}

// APY 小数 → 百分比串("0.03" → "3.00%")。savings `rate` / staking `apy` 均为年化小数。
const apyPct = (rate: string | number | undefined): string =>
  `${(Number(rate ?? 0) * 100).toFixed(2)}%`;

// —— 赚币(earn 桶)——
// savings(活期出借)/finance/savings/balance:data 扁平数组,每币一行,数量取 `amt`,`rate` 是年化 APY。
interface OkxSavingsRow {
  ccy?: string;
  amt?: string; // 出借本金(持有量口径)
  rate?: string; // 年化 APY(小数)
}
interface OkxSavingsResponse {
  code?: string;
  msg?: string;
  data?: OkxSavingsRow[];
}
// staking-defi 活跃订单 /finance/staking-defi/orders-active:每单一行,投入本金在 `investData[].amt`,`apy` 年化。
interface OkxStakingInvest {
  ccy?: string;
  amt?: string;
}
interface OkxStakingOrder {
  ccy?: string;
  protocol?: string;
  apy?: string; // 年化 APY(小数)
  investData?: OkxStakingInvest[];
}
interface OkxStakingResponse {
  code?: string;
  msg?: string;
  data?: OkxStakingOrder[];
}

// earn 行的公共产出:算 spot、数量取总量字段、进净值,标 balance 级 Earn note(APY)+ note.group:"earn"。
// 价走提示表(同 funding);无价 → value 0 交 oracle。
function earnRow(ccy: string, amount: number, content: string, hint: PriceHint): Spot {
  const price = priceOf(ccy, hint);
  return {
    symbol: ccy,
    amount,
    price,
    value: price != null ? amount * price : 0,
    kind: "spot",
    tokenRef: tokenRef.issued(PROVIDER_ID, ccy.trim().toUpperCase()),
    note: { title: "Earn", icon: "info", content, group: "earn" },
  };
}

// 纯解析:活期出借 rows → Spot[]。数量取 amt,note `Flexible · X% APY`。跳过空 ccy / amt≤0。golden test。
export function parseSavings(rows: OkxSavingsRow[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const r of rows ?? []) {
    const ccy = r.ccy;
    const amount = Number(r.amt ?? 0);
    if (!ccy || !(amount > 0)) continue;
    out.push(earnRow(ccy, amount, `Flexible · ${apyPct(r.rate)} APY`, hint));
  }
  return out;
}

// 纯解析:链上赚币活跃订单 orders → Spot[]。每单 investData 逐条本金成行(数量取 amt),
// note `<protocol> · X% APY`。跳过空 ccy / amt≤0。链上赚币的币锁在协议里、不在交易账户,故不与
// trading 双算(质押凭证币 OKSOL/BETH 才在交易账户,那走 trading、本端点不产它们)。golden test。
export function parseStaking(orders: OkxStakingOrder[], hint: PriceHint): Spot[] {
  const out: Spot[] = [];
  for (const o of orders ?? []) {
    const label = o.protocol?.trim() || "Staking";
    for (const inv of o.investData ?? []) {
      const ccy = inv.ccy ?? o.ccy;
      const amount = Number(inv.amt ?? 0);
      if (!ccy || !(amount > 0)) continue;
      out.push(earnRow(ccy, amount, `${label} · ${apyPct(o.apy)} APY`, hint));
    }
  }
  return out;
}

// —— 四桶对账锚(asset-valuation)——
// /asset/asset-valuation 给四桶的**权威美元金额**。本片只用 earn 桶做残差兜底;四桶全量对账留片 4。
interface OkxValuationDetails {
  classic?: string;
  earn?: string;
  funding?: string;
  trading?: string;
}
interface OkxValuationResponse {
  code?: string;
  msg?: string;
  data?: Array<{ totalBal?: string; details?: OkxValuationDetails }>;
}

// 展示金额格式化($ + 千分位,整数)。account 级 Note 文案用。
const fmtUsd = (n: number): string =>
  `$${Math.round(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

// earn 桶残差 Note(account 级):拉到的 earn 子项(savings + staking)加总对不上 asset-valuation 的
// earn 桶,差额挂"未细分"提示,兜住 Folio 不细拉的 earn 子类(定期等)。**只在能可信估值时报**:
// 任一 earn 子项估不出价(无提示价、非稳定币)时残差不可信(是「拉到了但没估到价」而非「没拉到」)→ 不报,
// 避免虚报一个吓人的"未细分 $X"。差额 ≤ 阈值也不报。
export function earnResidualNote(
  earnBucketUsd: number,
  earnItems: Spot[],
  hint: PriceHint,
): Note | undefined {
  let valued = 0;
  let unpriced = 0;
  for (const item of earnItems) {
    if (priceOf(item.symbol, hint) != null) valued += item.value;
    else unpriced++;
  }
  if (unpriced > 0) return undefined; // 残差不可信 → 不报
  const residual = earnBucketUsd - valued;
  if (!(residual > EARN_RESIDUAL_MIN_USD)) return undefined;
  return {
    title: "Earn not itemized",
    icon: "info",
    content: `About ${fmtUsd(residual)} in Earn couldn't be itemized (fixed-term or other sub-types)`,
  };
}

// 出网:签名头 + 失败归类走共享的 http 包装(@folio/shared)。**没有限频器** —— 额度按账户自己
// 那把 key 算、一次同步只发 1 个请求,队永远是空的,装了拦不到任何东西(见 tests/no-gate.test.ts)。
//
// prehash = timestamp + 'GET' + requestPath;SIGN = base64(HMAC-SHA256)。
type OkxCreds = { apiKey: string; secret: string; passphrase: string };

// —— base URL 覆盖(#264)——
// 远程(CF Workers)出口 IP 被 OKX 按地区拒时,由 app 层从 env 注入代理 base;不设即原样直连。
// connector 不读 env、不知代理存在(原则 #5):只把 ctx.creds.OKX_API_BASE 当**不透明整串**用,缺省回退默认。
// key 由 provider.creds(PC)声明 → app 的 env 注入据此读值灌进 ctx.creds(不进 UI 表单)。
const OKX_BASE_KEY = "OKX_API_BASE";
function pickOkxBase(cfg: Record<string, unknown>): string {
  const v = cfg[OKX_BASE_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : OKX_API_BASE;
}

// 请求 client 工厂:base 按请求可覆盖,故不再模块级绑死单例。签名头 / 失败归类不变。
const makeRequest = (baseUrl: string) =>
  createHttpClient<OkxCreds>({
    baseUrl,
    headers: async (path, options) => {
      const creds = options?.context;
      if (!creds) throw new ProviderError("INVALID_CREDENTIALS", "okx: missing credentials");
      const ts = new Date().toISOString();
      return {
        [HEADER_KEY]: creds.apiKey,
        [HEADER_SIGN]: await hmacSha256(creds.secret, `${ts}GET${path}`, "base64"),
        [HEADER_TIMESTAMP]: ts,
        [HEADER_PASSPHRASE]: creds.passphrase,
        "Content-Type": "application/json",
      };
    },
    // OKX 的 auth 错通常是 200 + code(见下面 assertCodeOk),所以这里只管 HTTP 层。
    toFailure: ({ kind, where, status, retryAfterMs, cause }) => {
      if (kind === "network")
        return new ProviderError("UPSTREAM_ERROR", "okx request failed", { cause });
      if (kind === "auth") return new ProviderError("AUTH_FAILED", `okx auth failed (${status})`);
      if (kind === "rate-limited")
        return new ProviderError("RATE_LIMITED", "okx rate limited", { retryAfterMs });
      if (kind === "parse")
        return new ProviderError("PARSE_ERROR", `okx returned invalid JSON (${where})`, { cause });
      return new ProviderError("UPSTREAM_ERROR", `okx upstream error (${status})`);
    },
  });

// 业务层错误(HTTP 200 + code!="0"):凭据类 code → AUTH_FAILED,其余 → UPSTREAM_ERROR。
function assertCodeOk(body: { code?: string; msg?: string }): void {
  if (body.code === "0") return;
  const code = body.code ?? "unknown";
  const msg = body.msg || "okx error";
  if (AUTH_ERROR_CODES.has(code)) {
    throw new ProviderError("AUTH_FAILED", `okx auth failed (code ${code}: ${msg})`);
  }
  throw new ProviderError("UPSTREAM_ERROR", `okx error (code ${code}: ${msg})`);
}

// —— 账户级 creds(AC):apiKey(semi)/secret(secret)/passphrase(secret)。apiKey = 标识符
// (明文走 header,非认证秘密)→ semi;secret/passphrase 均为签名秘密 → secret。账户 creds 声明随
// provider(其天然消费者)落此;将来同 connector 多 provider 时提到 entry 共享。——
export const okxAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
  { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

export const okxProvider: BalanceProvider<Spot, typeof okxAccountCreds> = {
  id: PROVIDER_ID,
  label: "OKX",
  // 无全局 provider key —— 账户自己的 apiKey/secret/passphrase 即凭据,走 account.creds。
  // PC 在此仅作 **env 注入声明**(非真凭据):app 层据此 key 从 env 读值灌进 ctx.creds,供 base URL
  // 覆盖(#264)。不进 UI 表单(那只认 account.creds)、不加密/不导出;值可能含代理密钥 → 不可 echo/log。
  creds: [
    {
      key: OKX_BASE_KEY,
      type: "public",
      label: "API base URL",
      validator: z.string().trim().url(),
    },
  ],

  async fetchBalances(ctx): Promise<{ balances: Spot[]; note?: Note[] }> {
    const request = makeRequest(pickOkxBase(ctx.creds as Record<string, unknown>));
    const creds = ctx.account.creds;
    // 统一账户各桶用**同一把 key 并发**拉,合并成一份余额(ADR 0031)。本片接入交易账户(trading)+
    // 资金账户(funding)+ 赚币(savings + staking-defi)+ 对账锚(asset-valuation)。
    // 用 allSettled 而非 all:**等齐所有请求**再决定,避免某端点先失败时,并发的兄弟请求(异步签名仍在飞)
    // 漏到调用结束后才 fetch(fire-and-forget → 泄漏到下轮/污染测试 spy)。
    // **余额源桶(0-3)**语义仍是「任一失败即整次失败」(抛第一个错、下轮重试,不拿半份快照覆盖);逐桶
    // 「尽力而为」留片 4 把这里的 throw 换成收集 Note。**对账锚(4,asset-valuation)** 非余额源、只喂残差 Note,
    // 恒软处理:失败/异常只是本轮没那条 Note,绝不阻断同步。
    const settled = await Promise.allSettled([
      request(BALANCE_PATH, { context: creds }),
      request(FUNDING_BALANCES_PATH, { context: creds }),
      request(SAVINGS_BALANCE_PATH, { context: creds }),
      request(STAKING_ORDERS_ACTIVE_PATH, { context: creds }),
      request(ASSET_VALUATION_PATH, { context: creds }),
    ]);
    const balanceBuckets = settled.slice(0, 4);
    const firstRejected = balanceBuckets.find((r) => r.status === "rejected");
    if (firstRejected) throw (firstRejected as PromiseRejectedResult).reason;
    const [tradingBody, fundingBody, savingsBody, stakingBody] = balanceBuckets.map(
      (r) => (r as PromiseFulfilledResult<unknown>).value,
    ) as [OkxBalanceResponse, OkxFundingResponse, OkxSavingsResponse, OkxStakingResponse];
    // HTTP 200 + code!="0" 是 OKX 表达错误的主要方式,包管不到这一层。
    assertCodeOk(tradingBody);
    assertCodeOk(fundingBody);
    assertCodeOk(savingsBody);
    assertCodeOk(stakingBody);

    const details = tradingBody.data?.[0]?.details ?? [];
    // 交易账户市价表复用给资金/赚币估值(零额外请求,见 buildPriceHint)。
    const hint = buildPriceHint(details);
    const earnItems = [
      ...parseSavings(savingsBody.data ?? [], hint),
      ...parseStaking(stakingBody.data ?? [], hint),
    ];
    const balances: Spot[] = [
      ...parseBalances(details),
      ...parseFunding(fundingBody.data ?? [], hint),
      ...earnItems,
    ];

    // 对账锚(软):asset-valuation 的 earn 桶 vs 拉到的 earn 子项加总 → 差额挂"未细分"account 级 Note。
    const notes: Note[] = [];
    const valuation =
      settled[4].status === "fulfilled" ? (settled[4].value as OkxValuationResponse) : undefined;
    if (valuation?.code === "0") {
      const earnBucketUsd = Number(valuation.data?.[0]?.details?.earn ?? 0);
      if (earnBucketUsd > 0) {
        const residual = earnResidualNote(earnBucketUsd, earnItems, hint);
        if (residual) notes.push(residual);
      }
    }
    return { balances, note: notes.length ? notes : undefined };
  },

  // 校验:签名打 balance。走 fetchBalances 同一条判据(assertCodeOk):HTTP 层失败由 request 抛,
  // 业务码 code!="0" 由 assertCodeOk 分类(凭据类 → AUTH_FAILED,其余 → UPSTREAM_ERROR)。
  // 凭据被拒 → false;够不到上游 → 抛(契约见 connector.ts / errors.ts)。creds 已保证三项非空。
  async validateAccount(ctx): Promise<boolean> {
    const request = makeRequest(pickOkxBase(ctx.creds as Record<string, unknown>));
    try {
      const body = (await request(BALANCE_PATH, {
        context: ctx.account.creds,
      })) as OkxBalanceResponse;
      assertCodeOk(body);
      return true;
    } catch (err) {
      if (isCredentialRejection(err)) return false;
      throw err;
    }
  },
};
