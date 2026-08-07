import type {
  BalanceProvider,
  ConnectorError,
  CredField,
  Note,
  ProviderNeeds,
  Spot,
} from "@folio/connectors-basic";
import {
  make as makeOkxClient,
  OKX_API_BASE,
  type OkxClientApi,
  type OkxCreds,
  type OkxDetail,
} from "@folio/okx-client";
import { Effect } from "effect";
import { z } from "zod";
import { asConnector } from "../../upstream";
import { PROVIDER_ID } from "./constants";
import {
  bucketFailureNote,
  buildPriceHint,
  classicNote,
  earnResidualRow,
  parseBalances,
  parseFunding,
  parseSavings,
  parseStaking,
  perpNote,
} from "./parse";

// —— 账户级 creds(AC):apiKey(semi)/ secret(secret)/ passphrase(secret)——
// apiKey = 标识符(明文走 header,非认证秘密)→ semi;secret / passphrase 都是签名秘密 → secret。
export const okxAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
  { key: "passphrase", type: "secret", label: "Passphrase", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// —— base URL 覆盖(#264)—— 归适配层,client 只吃不透明的 `{ apiBase }`(ADR 0036 边界决定 2)。
const OKX_BASE_KEY = "OKX_API_BASE";
const baseFrom = (creds: Record<string, unknown>): string => {
  const v = creds[OKX_BASE_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : OKX_API_BASE;
};

// 统一账户的四个**余额桶**(ADR 0031)。名字进失败 Note,所以和取数绑在一起 ——
// 用 `Effect.partition` 的话成败两个数组不带来源,名字就得靠下标猜(binance 那片踩过)。
interface Bucket {
  readonly name: string;
  readonly rows: (
    client: OkxClientApi,
    creds: OkxCreds,
  ) => Effect.Effect<unknown, ConnectorError, ProviderNeeds>;
}

const TRADING: Bucket = { name: "Trading", rows: (c, creds) => asConnector(c.balance(creds)) };
const FUNDING: Bucket = {
  name: "Funding",
  rows: (c, creds) => asConnector(c.fundingBalances(creds)),
};
const SAVINGS: Bucket = {
  name: "Savings",
  rows: (c, creds) => asConnector(c.savingsBalance(creds)),
};
const STAKING: Bucket = {
  name: "Staking",
  rows: (c, creds) => asConnector(c.stakingOrders(creds)),
};

// 四个**余额源**桶。对账锚(asset-valuation)与合约探测(positions)不在此列 ——
// 它们不产余额,失败只是本轮少两条 Note,不参与「全军覆没」的判定。
const BUCKETS: readonly Bucket[] = [TRADING, FUNDING, SAVINGS, STAKING];

const withClient = <A, E>(
  creds: Record<string, unknown>,
  use: (client: OkxClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> => use(makeOkxClient({ apiBase: baseFrom(creds) }));

export const okxProvider: BalanceProvider<Spot, typeof okxAccountCreds> = {
  id: PROVIDER_ID,
  label: "OKX",
  // 无全局 provider key —— 账户自己那三样即凭据。PC 仅作 env 注入声明(base 覆盖),
  // 不进 UI 表单、不加密、不导出;值可能含代理密钥 → 不可 echo/log。
  creds: [
    {
      key: OKX_BASE_KEY,
      type: "public",
      label: "API base URL",
      validator: z.string().trim().url(),
    },
  ],

  fetchBalances: (ctx) =>
    withClient(ctx.creds, (client) =>
      Effect.gen(function* () {
        const creds = ctx.account.creds;

        // 六个端点**同一把 key 并发**拉。业务码(HTTP 200 + code≠"0")已经由 client 判成失败,
        // 所以这里只需要 `Effect.either` —— 老那版要自己写一个 `readBucket` 把 rejected 和
        // 「200 但码不对」两种失败揉成一种,那段随 client 接手业务码一起没了。
        const [buckets, valuation, positions] = yield* Effect.all(
          [
            Effect.all(
              BUCKETS.map((bucket) =>
                Effect.either(bucket.rows(client, creds)).pipe(
                  Effect.map((result) => ({ bucket, result })),
                ),
              ),
              { concurrency: "unbounded" },
            ),
            // 软信号:失败只是本轮没这两条 Note。
            Effect.either(asConnector(client.assetValuation(creds))),
            Effect.either(asConnector(client.positions(creds))),
          ],
          { concurrency: "unbounded" },
        );

        const failed = buckets.filter((b) => b.result._tag === "Left");
        // **全军覆没**(四个余额桶无一成功,如 429 打光所有端点)→ 失败,让 sync 重试,
        // 别拿一份空快照覆盖已有余额。只有**部分**失败才走尽力而为。
        if (failed.length === BUCKETS.length) {
          const first = failed[0];
          if (first?.result._tag === "Left") return yield* Effect.fail(first.result.left);
        }

        const bodyOf = <T>(bucket: Bucket): T | undefined => {
          const hit = buckets.find((b) => b.bucket === bucket);
          return hit?.result._tag === "Right" ? (hit.result.right as T) : undefined;
        };

        const details: OkxDetail[] =
          bodyOf<{ data?: { details?: OkxDetail[] }[] }>(TRADING)?.data?.[0]?.details ?? [];
        // 交易账户的市价表复用给资金 / 赚币估值(零额外请求)。trading 失败 → 空表,
        // 那些币交给 oracle 兜底(value 0)。
        const hint = buildPriceHint(details);

        const earnItems = [
          ...parseSavings(bodyOf<{ data?: never[] }>(SAVINGS)?.data ?? [], hint),
          ...parseStaking(bodyOf<{ data?: never[] }>(STAKING)?.data ?? [], hint),
        ];
        const balances: Spot[] = [
          ...parseBalances(details),
          ...parseFunding(bodyOf<{ data?: never[] }>(FUNDING)?.data ?? [], hint),
          ...earnItems,
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

        if (valuation._tag === "Right") {
          // earn 未细分(结构化 / 定期)→ 合成聚合行**计进净值**(金额已知)。
          // `earnComplete`:两个 earn 桶都拉到,残差才可信 —— 某个失败的话残差是「没拉到」
          // 而不是「未细分」,不能计入。
          const earnComplete = !failed.some((f) => f.bucket === SAVINGS || f.bucket === STAKING);
          if (earnComplete) {
            const earnBucketUsd = Number(valuation.right.data?.[0]?.details?.earn ?? 0);
            if (earnBucketUsd > 0) {
              const row = earnResidualRow(earnBucketUsd, earnItems, hint);
              if (row) balances.push(row);
            }
          }
          // classic 整桶漏拉 → 账户级 Note(不像 earn 有可直接计入的残差,先只提示)。
          const cn = classicNote(valuation.right);
          if (cn) notes.push(cn);
        }

        // 合约持仓非空 → 兜底 Note(本轮不解析 perp,见 ADR 0031)。
        if (positions._tag === "Right") {
          const pn = perpNote(positions.right);
          if (pn) notes.push(pn);
        }

        return { balances, note: notes.length ? notes : undefined };
      }),
    ),

  // 校验:打一次交易账户余额。凭据被拒 → 成功返回 `false`;够不到上游 → 留在错误通道。
  // OKX 的凭据错通常是 **HTTP 200 + code 50xxx**,client 已经把那些码判成「凭据问题」。
  validateAccount: (ctx) =>
    withClient(ctx.creds, (client) =>
      asConnector(client.balance(ctx.account.creds)).pipe(
        Effect.as(true),
        Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
      ),
    ),
};
