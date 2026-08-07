import {
  type BalanceProvider,
  ConnectorAuthError,
  type ConnectorError,
  type CredField,
  type ProviderNeeds,
} from "@folio/connectors-basic";
import { make as makeZerionClient, type ZerionClientApi } from "@folio/zerion-client";
import { Effect } from "effect";
import { z } from "zod";
import { asConnector } from "../../upstream";
import type { evmAccountCreds } from "./creds";
import { parsePositions, type Row } from "./zerion-parse";

// 【evm connector 的**备用**取数源】—— 要一把 key,但一发拿回全链的仓位(含 defi)。
// 现在不参与取数(`defaultEnabled: false`),留着是为了将来做「运行时选源」。

const ZERION_API_KEY = "ZERION_API_KEY";

// —— provider 级 creds(PC):Zerion API Key —— DEFAULT provider key,值由 app 从 env 注入。
const zerionProviderCreds = [
  { key: ZERION_API_KEY, type: "secret", validator: z.string().min(1), label: "Zerion API Key" },
] as const satisfies readonly CredField[];

const withZerion = <A, E>(
  use: (client: ZerionClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => Effect.scoped(Effect.flatMap(makeZerionClient(), use));

// provider key 由 app 从 env 注入(非用户输入),但仍然自查 —— 没配就是没配,归「凭据问题」。
const zerionKeyOf = (creds: Record<string, string>): Effect.Effect<string, ConnectorError> => {
  const apiKey = creds[ZERION_API_KEY];
  return apiKey
    ? Effect.succeed(apiKey)
    : Effect.fail(new ConnectorAuthError({ message: `${ZERION_API_KEY} not configured` }));
};

export const zerionProvider: BalanceProvider<
  Row,
  typeof evmAccountCreds,
  typeof zerionProviderCreds
> = {
  id: "zerion",
  label: "Zerion",
  creds: zerionProviderCreds,
  // **备源**:默认取数走 rabby(不要 key、两发拿全链)。留着是为了将来做「运行时选源」
  // (ADR 0009 决策 #8)—— 有 ZERION_API_KEY 的人可以选回来。
  // `selectProvider` 跳过 `defaultEnabled === false` 的,所以它现在不参与取数。
  defaultEnabled: false,

  fetchBalances: (ctx) =>
    zerionKeyOf(ctx.creds).pipe(
      Effect.flatMap((apiKey) =>
        withZerion((client) =>
          // 链映射与仓位**并发**取(与 rabby 相反:zerion 按 key 计额、不掐瞬时并发)。
          // 链映射拿不到就整体失败 —— `parsePositions` 必须拿到非空映射才只产规范的
          // `evm:<chainId>` 标识;失败即不产,绝不写一份含分叉标识的快照。
          Effect.all(
            [
              asConnector(client.positions({ address: ctx.account.creds.address, apiKey })),
              asConnector(client.chainIds(apiKey)),
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map(([positions, chainIds]) => ({
              balances: parsePositions(positions, chainIds),
            })),
          ),
        ),
      ),
    ),

  // 低消耗校验:打轻量 portfolio 端点探活。没配 key 也走这条 —— 那是「凭据问题」,答案就是 false。
  validateAccount: (ctx) =>
    zerionKeyOf(ctx.creds).pipe(
      Effect.flatMap((apiKey) =>
        withZerion((client) =>
          asConnector(client.portfolio({ address: ctx.account.creds.address, apiKey })),
        ),
      ),
      Effect.as(true),
      Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
    ),
};
