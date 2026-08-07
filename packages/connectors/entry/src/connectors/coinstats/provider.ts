import { type CoinstatsClientApi, make as makeCoinstatsClient } from "@folio/coinstats-client";
import {
  type BalanceProvider,
  ConnectorAuthError,
  type ConnectorError,
  type CredField,
  type FetchContext,
  type ProviderNeeds,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { z } from "zod";
import { asConnector } from "../../upstream";
import { COINSTATS_API_KEY, PROVIDER_ID } from "./constants";
import { parseBalances, type Row } from "./parse";

// —— 账户级 creds(AC):地址 ——
// 地址非空即可(solana base58 / sui 0x+64hex / cosmos bech32 格式各异,交 API 判定,与旧行为一致)。
export const coinstatsAccountCreds = [
  { key: "address", type: "public", label: "Wallet Address", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// —— provider 级 creds(PC):CoinStats API Key —— DEFAULT provider key,值由 app 从 env 注入,
// 用户自配留后续 phase。secret(仅声明形状;本包不加密、不见 SECRETS_KEY)。
const providerCreds = [
  {
    key: COINSTATS_API_KEY,
    type: "secret",
    validator: z.string().min(1),
    label: "CoinStats API Key",
  },
] as const satisfies readonly CredField[];

type CoinstatsCtx = FetchContext<{ address: string }, Record<string, string>>;

// client 每次调用现建(它带闸 → 要 `Scope`)。**这不影响那把 key 的额度** ——
// 队的身份是 **key 的名字**(模块级游标),不是 client 实例:三条链、三个 connector、
// 每次调用各建一个 client,花的仍然是同一份额度、排的仍然是同一个队。这正是要的。
const withClient = <A, E>(
  use: (client: CoinstatsClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => Effect.scoped(Effect.flatMap(makeCoinstatsClient(), use));

// provider key 由 app 从 env 注入(非用户输入),但**仍然自查** —— 没配就是没配,
// 归「凭据问题」(重试改变不了),不该让它变成一发打不通的请求。
const apiKeyOf = (ctx: CoinstatsCtx): Effect.Effect<string, ConnectorError> => {
  const apiKey = ctx.creds[COINSTATS_API_KEY];
  return apiKey
    ? Effect.succeed(apiKey)
    : Effect.fail(new ConnectorAuthError({ message: `${COINSTATS_API_KEY} not configured` }));
};

const balanceOf = (
  connectionId: string,
  ctx: CoinstatsCtx,
): Effect.Effect<Row[], ConnectorError, ProviderNeeds> =>
  apiKeyOf(ctx).pipe(
    Effect.flatMap((apiKey) =>
      withClient((client) =>
        asConnector(client.balance({ connectionId, address: ctx.account.creds.address, apiKey })),
      ),
    ),
    // ⚠️ fallbackChain = connectionId(含 sui 的 "sui-wallet"):无 chain 的 coin 退化按
    // connectionId 归链,与迁移前完全一致。
    Effect.map((coins) => parseBalances(coins, connectionId)),
  );

// 工厂:为一条链绑定它的 `connectionId`,产出一个 `BalanceProvider`(三条链共享上面的实现)。
// 三份 connector manifest(solana / sui / cosmos)各调一次。
export function createCoinstatsProvider(
  connectionId: string,
): BalanceProvider<Row, typeof coinstatsAccountCreds, typeof providerCreds> {
  return {
    id: PROVIDER_ID,
    label: "CoinStats",
    creds: providerCreds,

    fetchBalances: (ctx) =>
      balanceOf(connectionId, ctx).pipe(Effect.map((balances) => ({ balances }))),

    // 低消耗校验:打一次 wallet/balance 探活(地址已由 validateCredentials 保证非空)。
    // **没配 key 也走这条路** —— `apiKeyOf` 报的是「凭据问题」,而这里对凭据问题的答案就是 `false`。
    // 老那版为它单写了一个 `if (!apiKey) return false` 前置分支,那是同一件事写了两遍。
    validateAccount: (ctx) =>
      balanceOf(connectionId, ctx).pipe(
        Effect.as(true),
        Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
      ),
  };
}
