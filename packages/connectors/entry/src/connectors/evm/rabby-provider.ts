import type { BalanceProvider, CredField, ProviderNeeds } from "@folio/connectors-basic";
import { make as makeRabbyClient, type RabbyClientApi } from "@folio/rabby-client";
import { Effect } from "effect";
import { z } from "zod";
import { asConnector } from "../../upstream";
import type { evmAccountCreds } from "./creds";
import { parseProtocols, parseTokens, type Row } from "./rabby-parse";

// 【evm connector 的**默认**取数源】—— 不要 API key,两发拿回全链。代价是请求要签名
// (那套 wasm 签名怎么进 Worker 见 `@folio/rabby-client` 的 signer)。

// —— provider 级 creds(PC):只有一个 base URL 覆盖(FOL-84)——
// 与 binance / okx / bybit 的 #264 同一个开关、同一条注入路(key 即 env 变量名,app 从 env 灌进
// `ctx.creds`,不进 UI 表单)。**生产不设** → 直连 api.rabby.io;设了的只有本地 perf 压测
// (`scripts/perf/fake-upstream.mjs`)。仍然「不要 key」—— 这正是它当默认源的理由。
const RABBY_BASE_KEY = "RABBY_API_BASE";
const providerCreds = [
  {
    key: RABBY_BASE_KEY,
    type: "public",
    label: "Rabby API base URL",
    validator: z.string().trim().url(),
  },
] as const satisfies readonly CredField[];

// client 每次调用现建(它带闸 → 要 `Scope`)。闸的状态是模块级的,重建壳子不重置额度。
const withRabby = <A, E>(
  creds: Record<string, unknown>,
  use: (client: RabbyClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => {
  const v = creds[RABBY_BASE_KEY];
  const apiBase = typeof v === "string" && v.trim() ? v.trim() : undefined;
  return Effect.scoped(Effect.flatMap(makeRabbyClient({ apiBase }), use));
};

export const rabbyProvider: BalanceProvider<Row, typeof evmAccountCreds, typeof providerCreds> = {
  id: "rabby",
  label: "Rabby",
  creds: providerCreds,

  fetchBalances: (ctx) =>
    withRabby(ctx.creds, (client) =>
      Effect.gen(function* () {
        const address = ctx.account.creds.address;
        // **刻意串行,不并发** —— 单账户的瞬时并发压到 1。sync 已经在账户维度并发 6 了,
        // 每个账户再并发 3 发就是 ~18,正压在 rabby 的坎上(见 client 里限频那段)。
        //
        // 用 `Effect.all` 的默认(顺序)而不是 `{ concurrency: "unbounded" }`:**默认就是串行**,
        // 所以这里不需要写任何东西来「阻止并发」—— 想并发才要显式说。老那版是三个 `await`
        // 摞着,读的人得自己确认「这里为什么没有 Promise.all」。
        const [chainIds, tokens, protocols] = yield* Effect.all([
          asConnector(client.chainIds),
          asConnector(client.tokens(address)),
          asConnector(client.protocols(address)),
        ]);
        return {
          balances: [...parseTokens(tokens, chainIds), ...parseProtocols(protocols, chainIds)],
        };
      }),
    ),

  // 低消耗校验:打最轻的 total_balance 探活(地址格式已由 validator 保证)。
  validateAccount: (ctx) =>
    withRabby(ctx.creds, (client) =>
      asConnector(client.totalBalance(ctx.account.creds.address)).pipe(
        Effect.as(true),
        Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
      ),
    ),
};
