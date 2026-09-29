import type {
  BalanceProvider,
  ConnectorError,
  CredField,
  ProviderNeeds,
} from "@folio/connectors-basic";
import {
  type ClearinghouseState,
  type HyperliquidClientApi,
  make as makeClient,
} from "@folio/hyperliquid-client";
import { Effect } from "effect";
import { z } from "zod";
import { asConnector } from "../../upstream";
import { EVM_ADDRESS_RE } from "./constants";
import { PROVIDER_ID, parseClearinghouseState, type Row } from "./parse";

// —— 账户级 creds(AC):EVM 地址,public(明文落库、可导出重建)——
export const hyperliquidAccountCreds = [
  {
    key: "address",
    type: "public",
    label: "EVM Address",
    desc: "0x + 40 hex",
    validator: z.string().regex(EVM_ADDRESS_RE, "expected 0x + 40 hex"),
  },
] as const satisfies readonly CredField[];

// —— base URL 覆盖(FOL-84)——
// 与 binance / okx / bybit 的 #264 同一个开关、同一条注入路(key 即 env 变量名,由 `creds`(PC)声明,
// app 据此从 env 读值灌进 `ctx.creds`)。**生产不设** → 直连官方;设了的只有本地 perf 压测
// (`scripts/perf/fake-upstream.mjs` 把它指到本机假上游)。
const HYPERLIQUID_BASE_KEY = "HYPERLIQUID_API_BASE";

// **client 的构造是纯的**(这家上游没有闸 → 没有 `Scope`)。别为了跟 binance 形状一致
// 而假装需要 scope —— 那条写在 CODING.md 的 Effect 一节里。默认那份建一次;有覆盖才现建。
const defaultClient: HyperliquidClientApi = makeClient();

const clientFor = (creds: Record<string, unknown>): HyperliquidClientApi => {
  const v = creds[HYPERLIQUID_BASE_KEY];
  return typeof v === "string" && v.trim() ? makeClient({ apiBase: v.trim() }) : defaultClient;
};

// —— provider 级 creds(PC):只有那个 base 覆盖(不进 UI 表单)——
const providerCreds = [
  {
    key: HYPERLIQUID_BASE_KEY,
    type: "public",
    label: "Hyperliquid API base URL",
    validator: z.string().trim().url(),
  },
] as const satisfies readonly CredField[];

export const hyperliquidProvider: BalanceProvider<
  Row,
  typeof hyperliquidAccountCreds,
  typeof providerCreds
> = {
  id: PROVIDER_ID,
  label: "Hyperliquid",
  // 只读地址即查,无全局 / provider key / 签名 → PC 只有那个 base 覆盖。
  creds: providerCreds,

  fetchBalances: (ctx) =>
    state(clientFor(ctx.creds), ctx.account.creds.address).pipe(
      Effect.map((json) => ({ balances: parseClearinghouseState(json) })),
    ),

  // 低消耗校验:打一次 clearinghouseState 探活(地址格式已由 validateCredentials 保证)。
  // 未交易过的地址也返回 200 + 空状态 → 视为可用。
  //
  // 公开 info 端点**没有 auth**,所以「凭据被拒」这条路实际走不到 —— 但仍然写上:
  // 契约要求两类失败分开,而「这家上游恰好不会返回 401」是上游的事,不是我们可以省一步的理由。
  validateAccount: (ctx) =>
    state(clientFor(ctx.creds), ctx.account.creds.address).pipe(
      Effect.as(true),
      Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
    ),
};

const state = (
  client: HyperliquidClientApi,
  address: string,
): Effect.Effect<ClearinghouseState, ConnectorError, ProviderNeeds> =>
  asConnector(client.clearinghouseState(address));
