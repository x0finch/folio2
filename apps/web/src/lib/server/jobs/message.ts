import { Either, ParseResult, Schema } from "effect";
import { PRICES_IDS_PER_MESSAGE } from "./constants";

// **队列里一条消息长什么样**(FOL-86,ADR 0055)。
//
// 判别在 `kind` 上 —— consumer 的分派(`./consume` 的 `runJob`)按它 `switch`,TS 保证穷尽:加一个
// kind 忘了接,编译不过。**加新 kind 的路**(FOL-88 那批:`fx` / `platforms` / `catalogue`
// / `defi-logos` / `prune-notes` / `daily-prices`):在这里加一个 `Schema.Struct` 并进 `Job` 的
// union,再在 `runJob` / `giveUp` 里各接一支。消息体只装**找得到活的那几个 id**,不装数据 —— 数据在
// 跑的那一刻从库里读,排队期间它可能已经变了。
//
// **进来的东西一律先过 schema。** 队列是 at-least-once、跨部署版本的:上一个版本投的、形状已经
// 改了的消息,完全可能落到新版本的 consumer 手里。解不开的 → ack + 记一行(`./consume`),
// **不重试** —— 重投一百次它也还是解不开。

/** 同步**一个**账户,并在它所属的那一轮里落账(ADR 0048)。cron 一个账户投一条。 */
export const SyncAccountJob = Schema.Struct({
  kind: Schema.Literal("sync-account"),
  userId: Schema.NonEmptyString,
  /** 那一轮的键(`sync-round:<portfolioId>`)。 */
  portfolioId: Schema.NonEmptyString,
  /** 那一轮的 id —— 键上已经换成别的轮了,这条消息就是过期的(`./consume` 跳过它)。 */
  roundId: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
});
export type SyncAccountJob = typeof SyncAccountJob.Type;

/**
 * 一个用户同步之后的参考层预热(平台元数据 / DeFi 协议图 / 汇率 / 目录)。**过渡形态**:FOL-88 会把它
 * 拆成 `fx` / `platforms` / `catalogue` / `defi-logos` 各自一条,每条各一份预算。持仓价已经拆出去了
 * (`prices`,FOL-87)。
 */
const WarmUserJob = Schema.Struct({
  kind: Schema.Literal("warm-user"),
  userId: Schema.NonEmptyString,
});

/**
 * 刷一个用户持仓的价(+ 元信息),按 100 个一批回源、写回价表(FOL-87)。同步的重估只读这张表。
 *
 *   · 不带 `tokenIds` → 「规划」那条(cron 一个用户投一条):跑的那一刻读最新快照 + 手记算持仓 id,
 *     自己刷前 `PRICES_IDS_PER_MESSAGE` 个,其余切块、每块再投一条带 `tokenIds` 的。
 *   · 带 `tokenIds` → 只刷这一块,不再往下投。
 *
 * 块的上限写进 schema:一条超预算的消息(手拼的、上一个版本投的)解码就拒,不会跑出 50 发去。
 * 这里装的是 id 而不是数据,与上面那条规矩不冲突 —— 价仍在跑的那一刻才取。
 */
export const PricesJob = Schema.Struct({
  kind: Schema.Literal("prices"),
  userId: Schema.NonEmptyString,
  tokenIds: Schema.optional(
    Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(PRICES_IDS_PER_MESSAGE)),
  ),
});
export type PricesJob = typeof PricesJob.Type;

export const Job = Schema.Union(SyncAccountJob, WarmUserJob, PricesJob);
export type Job = typeof Job.Type;

/**
 * 一条消息的 body → `Job`。解不开 → `Left` 带一句人话(**只有路径和期望,不回显值** —— body 里有
 * userId / accountId,日志红线 P6.7 只许记 accountId 这一级,而错误树会把整个输入打出来)。
 */
export const decodeJob = (body: unknown): Either.Either<Job, string> =>
  Either.mapLeft(Schema.decodeUnknownEither(Job)(body), (error) =>
    ParseResult.ArrayFormatter.formatErrorSync(error)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue._tag}`)
      .join("; "),
  );
