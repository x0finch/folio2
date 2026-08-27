import {
  type BinanceClientApi,
  type BinanceConfig,
  type BinanceCreds,
  make as makeBinanceClient,
} from "@folio/binance-client";
import type {
  BalanceProvider,
  ConnectorError,
  CredField,
  Note,
  ProviderNeeds,
} from "@folio/connectors-basic";
import { Effect, Fiber } from "effect";
import { z } from "zod";
import { asConnector } from "../../upstream";
import { PROVIDER_ID } from "./constants";
import {
  type BinanceRow,
  parseAccountBalances,
  parseCoinmFuturesAccount,
  parseEarnPositions,
  parseFundingAssets,
  parseFuturesAccount,
} from "./parse";

// —— 账户级 creds(AC):apiKey/secret。apiKey = 标识符(明文走 header,非认证秘密)→ semi:
// 导出打码保留供补录识别;secret = 签名密钥 → secret:导出剥离。——
export const binanceAccountCreds = [
  { key: "apiKey", type: "semi", label: "API Key", validator: z.string().trim().min(1) },
  { key: "secret", type: "secret", label: "API Secret", validator: z.string().trim().min(1) },
] as const satisfies readonly CredField[];

// —— base URL 覆盖(#264)——
// 远程(CF Workers)出口 IP 被 Binance 按地区拒时,由部署方经 env 注入代理 base;不设即直连。
//
// **归适配层,不归 client**(ADR 0036 边界决定 2):client 只吃不透明的 `{ apiBase, ... }`,
// 压根不知道有代理这回事。这里负责从 `ctx.creds` 挑出来递进去。
//
// key 即 env 变量名,由 `provider.creds`(PC)声明 → app 的 env 注入据此读值灌进 `ctx.creds`
// (不进 UI 表单)。值可能内含代理密钥 → 不可 echo/log(P6.7)。
const BASE_OVERRIDE = {
  apiBase: "BINANCE_API_BASE",
  fapiBase: "BINANCE_FAPI_BASE",
  dapiBase: "BINANCE_DAPI_BASE",
} as const;

const baseUrlSchema = z.string().trim().url();

const configFrom = (creds: Record<string, unknown>): BinanceConfig => {
  const pick = (key: string): string | undefined => {
    const v = creds[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  return {
    apiBase: pick(BASE_OVERRIDE.apiBase),
    fapiBase: pick(BASE_OVERRIDE.fapiBase),
    dapiBase: pick(BASE_OVERRIDE.dapiBase),
  };
};

// —— 多钱包骨架(ADR 0030)——
//
// 一个 Binance 账户 = 多个隔离**钱包**(现货 / 合约 / 资金 / 理财),同一把 key 并发拉。
// 尽力而为:某个钱包失败不阻断其余,失败收成一条账户级 Note。凭据类失败(没勾 Futures 权限的
// -2015)与瞬时故障(超时/5xx)一样降级为「该钱包失败」,不冒泡成整账户失败。
//
// **`prices` 是个 Fiber,不是 Promise。** 价表(公开、带闸)与各钱包(签名、无闸)要**并发**发起:
// 合约根本不需要价表,现货/资金/理财才 join 它。老那版用一个已经跑起来的 Promise 传进来,
// 于是必须额外写一句 `void prices.catch(() => {})` 防 unhandled rejection —— 一个 fiber 没人 join
// 不会有那种事,那句防御连同它要防的问题一起没了。
interface Wallet {
  readonly name: string; // 展示名(失败时列进 Note)
  readonly rows: (
    client: BinanceClientApi,
    creds: BinanceCreds,
    prices: Fiber.RuntimeFiber<Record<string, number>, ConnectorError>,
  ) => Effect.Effect<BinanceRow[], ConnectorError, ProviderNeeds>;
}

// 现货:签名 /api/v3/account,再 join 价表估值。
const spot: Wallet = {
  name: "Spot",
  rows: (client, creds, prices) =>
    Effect.all([asConnector(client.spotAccount(creds)), Fiber.join(prices)]).pipe(
      Effect.map(([account, priceMap]) => parseAccountBalances(account, priceMap)),
    ),
};

// U 本位合约:独立 host,一发拿权益 + 持仓。**合约自带 USD,不用价表** —— 所以它不 join。
const usdmFutures: Wallet = {
  name: "USDⓈ-M Futures",
  rows: (client, creds) =>
    asConnector(client.usdmAccount(creds)).pipe(Effect.map(parseFuturesAccount)),
};

// 币本位合约:又一个独立 host;权益折 USD 需要价表。
const coinmFutures: Wallet = {
  name: "COIN-M Futures",
  rows: (client, creds, prices) =>
    Effect.all([asConnector(client.coinmAccount(creds)), Fiber.join(prices)]).pipe(
      Effect.map(([account, priceMap]) => parseCoinmFuturesAccount(account, priceMap)),
    ),
};

// 资金账户:当 spot,ticker 估值。
const funding: Wallet = {
  name: "Funding",
  rows: (client, creds, prices) =>
    Effect.all([asConnector(client.fundingAssets(creds)), Fiber.join(prices)]).pipe(
      Effect.map(([assets, priceMap]) => parseFundingAssets(assets, priceMap)),
    ),
};

// 理财:活期 + 定期各自翻页取全(翻页在 client 里),当 spot、ticker 估值。
// 两个端点任一失败即该钱包失败 —— `Effect.all` 默认就是这个语义。
const earn: Wallet = {
  name: "Earn",
  rows: (client, creds, prices) =>
    Effect.all([
      asConnector(client.earnFlexible(creds)),
      asConnector(client.earnLocked(creds)),
      Fiber.join(prices),
    ]).pipe(
      Effect.map(([flexible, locked, priceMap]) =>
        parseEarnPositions({ rows: flexible }, { rows: locked }, priceMap),
      ),
    ),
};

const WALLETS: readonly Wallet[] = [spot, usdmFutures, coinmFutures, funding, earn];

// 账户级失败 Note(ADR 0030):列出没同步上的钱包 + 一句提示。
const walletFailureNote = (failed: readonly string[]): Note => ({
  title: "Wallets not synced",
  icon: "warning",
  content: `${failed.join(" / ")} — couldn't be read; check the API key's permissions or retry later`,
});

// 建这次调用要用的 client。
//
// **每次调用现建,不做成共享 Layer** —— 它要 `Scope`(闸的构造绑在 scope 上),而闸的**状态是模块级**
// (跨 isolate 的时隙游标),所以重建 client 壳不会重置额度桶,现建的代价只是几个闭包。
// 真正的原因是 base 覆盖来自 `ctx.creds`,这里才拿得到;而契约的 `R` 只有出网那一项,
// 让它多带一个 `BinanceClient` 会把九个上游的 client 全塞进契约。
const withClient = <A, E>(
  creds: Record<string, unknown>,
  use: (client: BinanceClientApi) => Effect.Effect<A, E, ProviderNeeds>,
): Effect.Effect<A, E, ProviderNeeds> =>
  Effect.scoped(Effect.flatMap(makeBinanceClient(configFrom(creds)), use));

export const binanceProvider: BalanceProvider<BinanceRow, typeof binanceAccountCreds> = {
  id: PROVIDER_ID,
  label: "Binance",
  // 无全局 provider key —— 账户自己的 apiKey/secret 即凭据,走 account.creds。
  // PC 在此仅作 **env 注入声明**(非真凭据):app 层据这些 key 从 env 读值灌进 ctx.creds,
  // 供上面的 base URL 覆盖用。不进 UI 表单、不加密、不导出。
  creds: [
    {
      key: BASE_OVERRIDE.apiBase,
      type: "public",
      label: "Spot API base URL",
      validator: baseUrlSchema,
    },
    {
      key: BASE_OVERRIDE.fapiBase,
      type: "public",
      label: "USDⓈ-M API base URL",
      validator: baseUrlSchema,
    },
    {
      key: BASE_OVERRIDE.dapiBase,
      type: "public",
      label: "COIN-M API base URL",
      validator: baseUrlSchema,
    },
  ],

  fetchBalances: (ctx) =>
    withClient(ctx.creds, (client) =>
      Effect.gen(function* () {
        const creds = ctx.account.creds;

        // 价表**先 fork 起来**:它带闸(按出口 IP),而签名端点不带 —— 不 fork 的话闸的等待会
        // 前置阻塞五个钱包的并发,限流时把整批同步拖垮。fork 之后闸在等,钱包照发。
        const prices = yield* Effect.fork(asConnector(client.tickerPrices));

        // 尽力而为:五个钱包全并发跑完,再看谁成谁败。
        //
        // **`Effect.either` + `Effect.all` 而不是 `Effect.partition`**:后者一句就能分开成败,
        // 但它**不告诉你哪个输入对应哪个失败** —— 而失败钱包的名字正是那条 Note 的全部内容。
        // 每个结果带着它的 wallet 一起出来,关联就不用靠下标去猜。
        const outcomes = yield* Effect.all(
          WALLETS.map((wallet) =>
            Effect.either(wallet.rows(client, creds, prices)).pipe(
              Effect.map((result) => ({ wallet, result })),
            ),
          ),
          { concurrency: "unbounded" },
        );

        const failed = outcomes.filter((o) => o.result._tag === "Left");

        // **被价表连坐的失败 → 整账户失败**(FOL-30)。
        //
        // 价表不是第六个钱包,是**四个钱包共用的估值原料**:现货 / 币本位 / 资金 / 理财都要 join 它
        // 才算得出 USD,只有 U 本位自带 USD 不 join。所以价表一挂,那四个会**一起**倒进失败堆,
        // 而「尽力而为」看不出这是同一个原因 —— 它照样写出一份只剩 U 本位的快照,把那四个钱包的
        // 真实资产整块盖掉(生产实况:每轮 cron 掉块,note 恒为那四个的名字)。
        //
        // 「拿不到料」该走的是重试,不是降级:交回错误通道 → sync 的退避重试(带 Retry-After)→
        // 打光则这一轮不写快照,旧值原样保住。
        //
        // **判据是「有钱包死在它手上」,不是「价表挂了」** —— 两者不等价,差别正好是个误伤:
        // key 只勾了合约权限时,那四个各自先死在自己的签名请求上(`Effect.all` 默认串行,失败即
        // 短路,压根没走到 join),价表挂没挂根本不影响结果。那时若也整账户失败,就是拿一个没人
        // 用得上的价表,把 U 本位真实拿回的余额丢掉、且因为限流可重试而白重试三次 —— 而那些 401
        // 是「没这个权限」,重试变不出权限来,于是这个账户永远写不进快照。
        //
        // 认「同一个错误对象」而不是比对 `_tag`:被连坐的钱包抛出的就是 `Fiber.join` 递上来的
        // 那一个,引用相等即「它就是死在价表上的」。比 tag 会把「钱包自己也撞了 429」误判成连坐。
        //
        // 这个 join 只在**有钱包已经 join 过**时才取到值(那时 fiber 早完成);其余情况它可能真等
        // 价表跑完 —— 上界是 sync 那层的单次超时,可接受。
        const priceTable = yield* Effect.either(Fiber.join(prices));
        if (priceTable._tag === "Left") {
          const collateral = failed.some(
            (o) => o.result._tag === "Left" && o.result.left === priceTable.left,
          );
          if (collateral) return yield* Effect.fail(priceTable.left);
        }
        const balances = outcomes.flatMap((o) => (o.result._tag === "Right" ? o.result.right : []));

        // **全军覆没**(无一钱包成功,如 429 打光所有端点)→ 失败,让 sync 重试,
        // 别拿一份空快照覆盖已有余额。只有**部分**失败才走尽力而为。
        if (failed.length === WALLETS.length) {
          const first = failed[0];
          if (first?.result._tag === "Left") return yield* Effect.fail(first.result.left);
        }

        return {
          balances,
          note: failed.length ? [walletFailureNote(failed.map((o) => o.wallet.name))] : undefined,
        };
      }),
    ),

  // 校验:签名打现货 /api/v3/account 确认 key + 读权限。只验现货(基础读权限)——
  // 部分授权(如没勾 Futures)是同步期尽力而为的事,不该卡住加账户。
  //
  // **契约的两类失败在这里各走各的通道**:凭据被拒 → 成功返回 `false`(等也没用,不该重试);
  // 够不到上游 → 留在错误通道,调用方据 `_tag` 重试。老那版是 try/catch + `isCredentialRejection`,
  // 现在是一步 `catchTag` —— 判据在类型里,漏一种会编译红。
  validateAccount: (ctx) =>
    withClient(ctx.creds, (client) =>
      asConnector(client.spotAccount(ctx.account.creds)).pipe(
        Effect.as(true),
        Effect.catchTag("ConnectorAuthError", () => Effect.succeed(false)),
      ),
    ),
};
