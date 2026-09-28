import { Either, ParseResult, Schema } from "effect";
import { PRICES_IDS_PER_MESSAGE } from "./constants";

// **队列里一条消息长什么样**(FOL-86,ADR 0055)。
//
// 判别在 `kind` 上 —— consumer 的分派(`./consume` 的 `runJob`)按它 `switch`,TS 保证穷尽:加一个
// kind 忘了接,编译不过。**加新 kind 的路**(下一个是 FOL-90 的 `daily-prices`):在这里加一个
// `Schema.Struct` 并进 `Job` 的 union,再在 `runJob` / `giveUp` 里各接一支,并在 `./schedule`
// 决定谁投、多久投一次。消息体只装**找得到活的那几个 id**,不装数据 —— 数据在
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

// —— 参考层的五件小活(FOL-88)——
//
// 以前是一条 `warm-user` 包下四件(平台 / DeFi 图 / 汇率 / 目录),剪 note 还在每天那个 cron 里
// 逐用户串行跑 —— 几件的出网与 CPU 叠在一次调用里。现在一件一条消息,各自一份 10ms / 50 发的预算
// (每件最坏出网数见 `./constants` 的 `REFERENCE_JOB_UPSTREAM_CALLS`)。
//
// 五条都只装 `userId`:汇率 / 平台 / 目录 / DeFi 图都住 per-user 缓存(`user_cache`),note 在用户的
// 快照上 —— 没有一件是全局的。跑什么、多久投一次见 `./schedule`。**五条都幂等**:汇率 / 平台 / 目录
// 各按自己的 TTL 门控(新鲜就零出网),DeFi 图是覆盖写,剪 note 是带 `IS NOT NULL` 门的 UPDATE。
const userJob = <K extends string>(kind: K) =>
  Schema.Struct({ kind: Schema.Literal(kind), userId: Schema.NonEmptyString });

/** 汇率:全部支持币种一把拉(`fx.warm()`),6h TTL 内零出网。 */
const FxJob = userJob("fx");
/** 平台元数据:最新快照里出现的链键,缺 / 过期才拉一次整张链表。 */
const PlatformsJob = userJob("platforms");
/** 代币目录(市值前 N):一周 TTL,内部门控 —— 绝大多数次零出网。 */
const CatalogueJob = userJob("catalogue");
/** DeFi 协议图:从最新快照的余额 meta 里收集、写缓存。零出网。 */
const DefiLogosJob = userJob("defi-logos");
/** 剪保留期外的展示 note(#456)。零出网。 */
const PruneNotesJob = userJob("prune-notes");

/** 上面五件共用一个 consumer 形状(只带 `userId`),`./consume` 按 kind 分派。 */
export type ReferenceJob =
  | typeof FxJob.Type
  | typeof PlatformsJob.Type
  | typeof CatalogueJob.Type
  | typeof DefiLogosJob.Type;
export type PruneNotesJob = typeof PruneNotesJob.Type;

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

export const Job = Schema.Union(
  SyncAccountJob,
  PricesJob,
  FxJob,
  PlatformsJob,
  CatalogueJob,
  DefiLogosJob,
  PruneNotesJob,
);
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
