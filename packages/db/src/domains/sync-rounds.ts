import { and, eq, sql } from "drizzle-orm";
import { Clock, Effect, Option } from "effect";
import { DbClient } from "../client";
import { CurrentUser } from "../current-user";
import { userCache } from "../schema";

// 一次同步轮的状态(ADR 0048)。**轮跑在服务端,所以状态也在服务端** —— 以前它记在浏览器的
// 模块级 store 里,于是 cron 的轮对面板永远隐形、刷新即失忆、两个设备各说各的。
//
// **住 `user_cache`,不建新表。**一组合一键(`sync-round:<portfolioId>`),值是这一组合**最近一轮**
// (进行中或已收官),新轮开轮即覆盖。加一张表要一份迁移、一套索引、一条清理策略,而这份数据
// 恰好就是 KV 该装的东西:一个键、一个 JSON、一个到期时刻,过期即作废。
//
// **心跳就是那一列 `expires_at`,不在 JSON 里再存一份。**开轮写 `now + ttl`,每个账户完成顺手续期;
// worker 死了,最后一次心跳过后它自然过期。判定一句话:**未收官且已过期 = 中断**(谁来判在 app,
// 这一层只如实交出 `finishedAt` 与 `expiresAt`)。
//
// **写入全是带轮 id 条件的单语句。**D1 没有交互式事务,单语句原子是这里唯一依赖的原语:上一轮的
// worker 还在跑而键上已是新一轮时,它那几笔写 `WHERE json_extract(v,'$.roundId') = 老轮` 匹配不上,
// **落空成 no-op**,不会把新轮的明细改花。读一遍再写会同时丢掉原子性、还得自己编一套并发故事。

/** 这一轮是谁发起的。cron 与手动写的是同一个形状 —— 所以 cron 的轮从此在面板上可见。 */
export type SyncRoundTrigger = "manual" | "cron";

/**
 * 一个账户在这一轮里的下场。**三分,不是「成功 / 失败」两分**(ADR 0048 裁定 7):
 * 缺凭据的账户既不是成功也不是失败,它是「你还没填 API key」——把它算进任何一边都在撒谎。
 */
export type SyncRoundAccountStatus = "pending" | "synced" | "failed" | "needs-keys";

export interface SyncRoundAccount {
  /** 开轮那一刻的展示名。冻在轮里 —— 事后改名不该让上一轮的失败清单变成一串陌生名字。 */
  label: string;
  status: SyncRoundAccountStatus;
  /** 上游的原话,只有 `failed` 才有。 */
  error?: string;
}

/** 一轮的全貌。`expiresAt` 来自那一行的 `expires_at` 列,不在 JSON 里(见文件头)。 */
export interface SyncRoundRecord {
  roundId: string;
  portfolioId: string;
  trigger: SyncRoundTrigger;
  startedAt: number;
  /** null = 还没收官(配合 `expiresAt` 才判得出「在跑」还是「中断」)。 */
  finishedAt: number | null;
  /** 整轮没跑起来时那一句(取账户 / 取凭据挂了),逐账户的失败不走这里。 */
  error?: string;
  /** accountId → 它这一轮怎么样了。 */
  accounts: Record<string, SyncRoundAccount>;
  expiresAt: number;
}

/** 这一层的契约 —— 从实现推导,不另抄一份签名。 */
export type SyncRoundStore = Effect.Effect.Success<typeof makeSyncRoundStore>;

export interface OpenSyncRoundInput {
  portfolioId: string;
  roundId: string;
  trigger: SyncRoundTrigger;
  accounts: readonly { id: string; label: string }[];
  /** 心跳时长。**由 app 给** —— 「多久没心跳算死」是同步编排的知识,不是存储的。 */
  ttlMs: number;
}

export interface SettleSyncRoundInput {
  portfolioId: string;
  roundId: string;
  accountId: string;
  status: Exclude<SyncRoundAccountStatus, "pending">;
  error?: string;
  ttlMs: number;
}

export interface FinishSyncRoundInput {
  portfolioId: string;
  roundId: string;
  /** 整轮没跑起来时那一句。 */
  error?: string;
  /** 收官后改长保留(下一轮开轮即覆盖,所以留久一点不占地方)。 */
  retentionMs: number;
}

// 一组合一键。前缀是 `user_cache` 的第四种键(另外三种在 oracle 的 cache.ts)。
const keyOf = (portfolioId: string) => `sync-round:${portfolioId}`;

// 落库的那一半 —— `SyncRoundRecord` 去掉 `expiresAt`(它是列,不是 JSON 字段)。
type StoredRound = Omit<SyncRoundRecord, "expiresAt">;

// **永远拿得到一段合法 JSON。**`json_extract` 碰上畸形值会直接让整条语句报错,而这个键上一个坏值
// 就够把那个组合的同步永久卡死(开不了轮、也读不出来)。裹一层 `iif` 之后,坏值等价于「这里没有轮」——
// 下一次开轮照常覆盖它。别改成 `json_valid(v) AND …`:`AND` / `OR` 的求值顺序不是语言保证。
const asJson = sql`iif(json_valid(${userCache.v}), ${userCache.v}, '{}')`;

const decode = (row: { v: string; expiresAt: number }): SyncRoundRecord | undefined => {
  try {
    const parsed = JSON.parse(row.v) as StoredRound;
    if (typeof parsed?.roundId !== "string") return undefined;
    return { ...parsed, accounts: parsed.accounts ?? {}, expiresAt: row.expiresAt };
  } catch {
    return undefined;
  }
};

export const makeSyncRoundStore = Effect.gen(function* () {
  const client = yield* DbClient;
  const userId = yield* CurrentUser;

  const mine = (portfolioId: string) =>
    and(eq(userCache.userId, userId), eq(userCache.k, keyOf(portfolioId)));

  // 「这一行装的还是同一轮吗」—— 每个写入都带着它,漏网的竞态因此落空成 no-op。
  const sameRound = (roundId: string) => sql`json_extract(${asJson}, '$.roundId') = ${roundId}`;

  const read = (portfolioId: string): Effect.Effect<Option.Option<SyncRoundRecord>> =>
    Effect.gen(function* () {
      const rows = yield* client.query((db) =>
        db
          .select({ v: userCache.v, expiresAt: userCache.expiresAt })
          .from(userCache)
          .where(mine(portfolioId)),
      );
      const row = rows[0];
      return Option.fromNullable(row ? decode(row) : undefined);
    });

  return {
    /**
     * 开一轮。**幂等**:键上已有一轮「未收官且未过期」的活轮 → 一个字都不写,返回那一轮
     * (`opened: false`)。第二个设备点同步、cron 撞上手动,看到的都是同一轮。
     *
     * 抢的那一手是**一条**条件 upsert(`ON CONFLICT DO UPDATE … WHERE 已收官或已过期`)+ `RETURNING`:
     * 抢到了才有行回来。抢不到再读一次现场 —— 那一读读到的必是赢家写下的那一轮。
     */
    open: (input: OpenSyncRoundInput): Effect.Effect<{ round: SyncRoundRecord; opened: boolean }> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const accounts: Record<string, SyncRoundAccount> = {};
        for (const a of input.accounts) accounts[a.id] = { label: a.label, status: "pending" };
        const fresh: StoredRound = {
          roundId: input.roundId,
          portfolioId: input.portfolioId,
          trigger: input.trigger,
          startedAt: now,
          finishedAt: null,
          accounts,
        };
        const v = JSON.stringify(fresh);
        const expiresAt = now + input.ttlMs;

        const won = yield* client.query((db) =>
          db
            .insert(userCache)
            .values({ userId, k: keyOf(input.portfolioId), v, expiresAt })
            .onConflictDoUpdate({
              target: [userCache.userId, userCache.k],
              set: { v: sql`excluded.v`, expiresAt: sql`excluded.expires_at` },
              // 覆盖的条件 = 「那一轮已经不活了」:收过官,或者心跳断了。
              // `<=` 而不是 `<` —— `expiresAt` 是「活到这一刻为止」,与 cache 的 stale 判据同款。
              setWhere: sql`json_extract(${asJson}, '$.finishedAt') is not null or ${userCache.expiresAt} <= ${now}`,
            })
            .returning({ v: userCache.v, expiresAt: userCache.expiresAt }),
        );
        const mineNow = won[0] ? decode(won[0]) : undefined;
        if (mineNow) return { round: mineNow, opened: true };

        const existing = yield* read(input.portfolioId);
        return Option.match(existing, {
          // 读不到只可能是那一行在这两句之间被删了(级联删用户)。当作没开成,别谎报一轮在跑。
          onNone: () => ({ round: { ...fresh, expiresAt }, opened: false }),
          onSome: (round) => ({ round, opened: false }),
        });
      }),

    /** 读这个组合最近一轮。没有过 → `none`(坏值同待遇:下一次开轮会覆盖它)。 */
    get: read,

    /**
     * 记一个账户的下场,并把心跳续到 `now + ttl`。
     *
     * **认不出的 accountId 不往明细里凭空加一条**(`json_type(…) IS NOT NULL` 那一句):
     * 开轮那一刻的名单就是这一轮的分母,事后长出一条会让 `x / N` 里的 N 自己变大。
     */
    settle: (input: SettleSyncRoundInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // 路径里的键交给 `json_quote` 拼 —— 转义规则归 SQLite,不由这里手写一份。
        const path = sql`'$.accounts.' || json_quote(${input.accountId})`;
        const next =
          input.error === undefined
            ? sql`json_set(${userCache.v}, ${path} || '.status', ${input.status})`
            : sql`json_set(${userCache.v}, ${path} || '.status', ${input.status}, ${path} || '.error', ${input.error})`;
        yield* client.query((db) =>
          db
            .update(userCache)
            .set({ v: next, expiresAt: now + input.ttlMs })
            .where(
              and(
                mine(input.portfolioId),
                sameRound(input.roundId),
                sql`json_type(${asJson}, ${path}) is not null`,
              ),
            ),
        );
      }),

    /** 收官:落 `finishedAt`(+ 整轮失败那一句),并把保留期改长。 */
    finish: (input: FinishSyncRoundInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const next =
          input.error === undefined
            ? sql`json_set(${userCache.v}, '$.finishedAt', ${now})`
            : sql`json_set(${userCache.v}, '$.finishedAt', ${now}, '$.error', ${input.error})`;
        yield* client.query((db) =>
          db
            .update(userCache)
            .set({ v: next, expiresAt: now + input.retentionMs })
            .where(and(mine(input.portfolioId), sameRound(input.roundId))),
        );
      }),
  };
});
