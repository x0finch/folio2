import {
  BYBIT_API_BASE,
  type BybitClientApi,
  type BybitCoin,
  type BybitCreds,
  make as makeBybitClient,
} from "@folio/bybit-client";
import type {
  BalanceProvider,
  ConnectorError,
  CredField,
  Note,
  ProviderNeeds,
  Spot,
} from "@folio/connectors-basic";
import { Effect } from "effect";
import { z } from "zod";
import { asConnector, bestEffortVerdict } from "../../upstream";
import { EARN_CATEGORIES, PROVIDER_ID } from "./constants";
import {
  bucketFailureNote,
  buildPriceHint,
  parseEarn,
  parseFunding,
  parseUnified,
  perpFallbackNote,
} from "./parse";

// —— 账户级 creds(AC):apiKey(semi)/ secret(secret)——
export const bybitAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// —— base URL 覆盖(#264)—— 归适配层,client 只吃不透明的 `{ apiBase }`(ADR 0036 边界决定 2)。
const BYBIT_BASE_KEY = "BYBIT_API_BASE";
const baseFrom = (creds: Record<string, unknown>): string => {
  const v = creds[BYBIT_BASE_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : BYBIT_API_BASE;
};

// 四个桶(ADR 0032):统一账户 + 资金账户 + 赚币两类。名字进失败 Note,所以和取数绑一起。
interface Bucket {
  readonly name: string;
  readonly rows: (
    client: BybitClientApi,
    creds: BybitCreds,
  ) => Effect.Effect<unknown, ConnectorError, ProviderNeeds>;
}

const UNIFIED: Bucket = {
  name: "Unified",
  rows: (c, creds) => asConnector(c.walletBalance(creds)),
};
const FUNDING: Bucket = {
  name: "Funding",
  rows: (c, creds) => asConnector(c.fundingBalances(creds)),
};
const EARN: readonly Bucket[] = EARN_CATEGORIES.map((e) => ({
  name: `Earn (${e.label})`,
  rows: (c, creds) => asConnector(c.earnPositions(creds, e.category)),
}));
const BUCKETS: readonly Bucket[] = [UNIFIED, FUNDING, ...EARN];

const withClient = <A, E>(
  creds: Record<string, unknown>,
  use: (client: BybitClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => use(makeBybitClient({ apiBase: baseFrom(creds) }));

export const bybitProvider: BalanceProvider<Spot, typeof bybitAccountCreds> = {
  id: PROVIDER_ID,
  label: "Bybit",
  // 无全局 provider key —— 账户自己的 apiKey/secret 即凭据。PC 仅作 env 注入声明(base 覆盖),
  // 不进 UI 表单、不加密、不导出;值可能含代理密钥 → 不可 echo/log。
  creds: [
    {
      key: BYBIT_BASE_KEY,
      type: "public",
      label: "API base URL",
      validator: z.string().trim().url(),
    },
  ],

  fetchBalances: (ctx) =>
    withClient(ctx.creds, (client) =>
      Effect.gen(function* () {
        const creds = ctx.account.creds;

        // 各桶**同一把 key 并发**拉。业务码(HTTP 200 + retCode≠0)已经由 client 判成失败。
        // **perp 兜底不额外打 position/list** —— 统一账户响应自带的 `totalPerpUPL` 非零即有浮盈
        // 被排除在余额外,零额外请求。
        const outcomes = yield* Effect.all(
          BUCKETS.map((bucket) =>
            Effect.either(bucket.rows(client, creds)).pipe(
              Effect.map((result) => ({ bucket, result })),
            ),
          ),
          { concurrency: "unbounded" },
        );

        // 成败裁定三家 CEX 同一把尺子(瞬时错升级 / 全军覆没),住 ../../upstream。
        const failed = yield* bestEffortVerdict(outcomes);

        const bodyOf = <T>(bucket: Bucket): T | undefined => {
          const hit = outcomes.find((o) => o.bucket === bucket);
          return hit?.result._tag === "Right" ? (hit.result.right as T) : undefined;
        };

        const list = bodyOf<{
          result?: { list?: { coin?: BybitCoin[]; totalPerpUPL?: string }[] };
        }>(UNIFIED)?.result?.list?.[0];
        const coins = list?.coin ?? [];
        // 统一账户的市价表复用给资金 / 赚币估值(零额外请求)。统一账户失败 → 空表,
        // 那些币交给 oracle 兜底(value 0)。
        const hint = buildPriceHint(coins);

        const balances: Spot[] = [
          ...parseUnified(coins),
          ...parseFunding(
            bodyOf<{ result?: { balance?: never[] } }>(FUNDING)?.result?.balance ?? [],
            hint,
          ),
          ...EARN.flatMap((bucket, i) =>
            parseEarn(
              bodyOf<{ result?: { list?: never[] } }>(bucket)?.result?.list ?? [],
              EARN_CATEGORIES[i].label,
              hint,
            ),
          ),
        ];

        const notes: Note[] = [];
        if (failed.length) {
          notes.push(
            bucketFailureNote(
              failed.map((f) => ({
                name: f.bucket.name,
                auth: f.result._tag === "Left" && f.result.left._tag === "ConnectorAuthError",
              })),
            ),
          );
        }
        const upl = Number(list?.totalPerpUPL ?? 0);
        if (list && upl !== 0) notes.push(perpFallbackNote(upl));

        return { balances, note: notes.length ? notes : undefined };
      }),
    ),

  // 校验:签名打统一账户余额确认 key + 读权限。凭据被拒 → 成功返回 `false`;
  // 够不到上游 → 留在错误通道。Bybit 的凭据错是 HTTP 200 + retCode 1000x,client 已判成凭据问题。
  validateAccount: (ctx) =>
    withClient(ctx.creds, (client) =>
      asConnector(client.walletBalance(ctx.account.creds)).pipe(
        Effect.as(true),
        Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
      ),
    ),
};
