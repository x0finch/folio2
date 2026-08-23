import type { TokenRef, TokenRefIndexRow } from "@folio/oracle-basic";
import { formatTokenRef, parseTokenRef } from "@folio/oracle-ref";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { chunk, DbClient } from "../client";
import { globalTokenRefIndex } from "../schema";

// `global_token_ref_index`:链上地址 → 上游对同一个币的叫法(ADR 0022,#199)。
//
// **契约就是下面这段实现**,不再由 `@folio/oracle-basic` 定一个 `GlobalTokenRefIndexStore`
// 接口、这里顶上去。那套倒置是给「同一份契约会有第二种实现」准备的,而这张表只可能落 D1 ——
// 唯一的第二实现是 oracle 自己测试里的内存假货,它照着这个形状写就行。少一层之后,
// 「这个方法要什么、返回什么」只有一处可读,doc 也只有一份(以前实现与接口各一份,已经开始飘)。
//
// **这是全仓唯一没有 userId 的数据访问**(另一处是历史日价表,同一类理由):表里一条用户数据
// 都没有 —— 全是上游的公开知识、可整表重建、删空只是下一轮慢一点。CLAUDE.md 原则 #6 的受控例外。
//
// cron 一天一次整份灌(几万行 → 必须分批);sync 只正查、零网络。

// —— 批大小按实测定(#199 的验收项;2026-07-26 跑真 workerd,但在**本机 Miniflare** 上,非 CF 边缘)——
//
//   响应 2.63 MB · 17,841 个币 · `/asset_platforms` 列 461 条链 · 产出 **23,004 行**(跳过 1,530 条残缺条目)
//   链对照零失配(`unmatchedPlatforms` 为空)—— 显式的非 EVM slug 表是全的。以上三项与在哪跑无关。
//   CPU:`JSON.parse` 27ms + 纯转换 22ms ≈ **50ms**(同一个 workerd/V8,CPU 是本机的 → 同量级参考)。
//   **写入耗时未测**:本机那次 636ms 是 Miniflare 的本地 SQLite;远端 D1 每批一次网络往返,
//   24 批在生产上会明显更慢。批数是按参数上限定的,不依赖那个耗时。
//
// **原来的算法是错的**:注释写「每行 4 个参数 → 一批 20 行 = 80 个,稳在 100 参数上限内」——
// 那个上限是**每条语句**的,而当时每行本来就是自己一条 INSERT(4 个参数),压根碰不到。
// 于是批被切小了 50 倍:23,004 行要 **1,151 次 D1 往返**,全在一个 cron 调用里串着跑。
//
// 改成两级:一条语句塞多行(多行 INSERT),一批塞多条语句。
//   · 20 行/语句 × 4 = 80 个参数 —— 这才是那个上限真正约束的地方
//   · 50 语句/批 = 1000 行/批 → 23,004 行 = **24 批**(实测 636ms 写完)
const ROWS_PER_STATEMENT = 20;
const STATEMENTS_PER_BATCH = 50;

// 不碰 `Clock`(另外三个 store 都要):本 store 没有一处需要「现在几点」——
// `putAll` 的时刻由调用方给(契约如此,cron 记的是那一轮的时刻),读侧无 TTL 门控。
/**
 * 这张表的契约 —— **从实现推出来的,不是另抄一份签名**。
 *
 * 出包是给 `@folio/oracle` 用的:它的 mint 那一片把这个 store 当参数传下去
 * (`MintDeps.globalRefIndex`),要一个能写在签名里的名字。
 */
export type GlobalRefIndexStore = Effect.Effect.Success<typeof makeGlobalRefIndexStore>;

export const makeGlobalRefIndexStore = Effect.gen(function* () {
  const client = yield* DbClient;

  return {
    // 正查一批:上游 `upstream` 对这些链上 ref 的**整条**叫法(`coingecko/issued:bitcoin`,
    // 不是半截 —— 调用方拿来直接用,不再拼装,#228)。miss 的键不出现在结果里。
    lookup: (
      upstream: string,
      chainRefs: readonly TokenRef[],
    ): Effect.Effect<Map<TokenRef, TokenRef>> =>
      Effect.gen(function* () {
        const out = new Map<TokenRef, TokenRef>();
        if (chainRefs.length === 0) return out;
        // 表里 chain_ref 存的是规范形(灌表时经文法构造),查之前把入参也归一一遍 ——
        // 否则同一个地址大小写不同就查不到。读不懂的串不进表,直接跳过。
        const canonical = new Map<TokenRef, TokenRef>(); // 规范形 → 调用方原样给的串
        for (const raw of new Set(chainRefs)) {
          const parts = parseTokenRef(raw);
          if (parts.kind !== "unknown") canonical.set(formatTokenRef(parts), raw);
        }
        if (canonical.size === 0) return out;

        // **`forEach` 遍的是「块」,不是「键」** —— 不是每个 ref 查一次。一条 D1 语句只放得下
        // 约 100 个绑定参数,所以 `WHERE chain_ref IN (…)` 得切成每块 ≤90 个键、一块一条语句
        // (见 ./service.ts 末尾)。sync 一轮问几百个 ref,那就是几条语句,不是几百条。
        // 顺序跑:与迁移前逐字一致,要并发得先量一次真实批量。
        const parts = chunk([...canonical.keys()]).filter((p) => p.length > 0);
        const batches = yield* Effect.forEach(parts, (part) =>
          client.query((db) =>
            db
              .select({
                chainRef: globalTokenRefIndex.chainRef,
                upstreamLocalName: globalTokenRefIndex.upstreamLocalName,
              })
              .from(globalTokenRefIndex)
              .where(
                and(
                  eq(globalTokenRefIndex.upstream, upstream),
                  inArray(globalTokenRefIndex.chainRef, part),
                ),
              ),
          ),
        );
        // 值 = 整条 upstream ref:两列 (upstream, upstream_local_name) 经文法拼回(与 ./token
        // 同构;#228:调用方拿整条直接用,不再自己拼 issued: 那段)。键用调用方原样给的串回填。
        for (const rows of batches) {
          for (const r of rows) {
            const key = canonical.get(r.chainRef);
            if (key !== undefined) {
              out.set(key, formatTokenRef({ namer: upstream, localName: r.upstreamLocalName }));
            }
          }
        }
        return out;
      }),

    // 整份刷新。**不删行**:下架币的旧映射留着无害,`updated_at` 用来看哪些行这轮没被刷到。
    // 落表时把整条 `upstreamRef` 拆成 (upstream, upstream_local_name) 两列 —— 与 ./token 同构。
    // 读不懂的 upstreamRef(理论上不会,adapter 恒产规范形)直接跳过。两级分批见上面的常量。
    putAll: (rows: readonly TokenRefIndexRow[], updatedAt: number): Effect.Effect<void> =>
      Effect.suspend(() => {
        const split = rows.flatMap((r) => {
          const parts = parseTokenRef(r.upstreamRef);
          if (parts.kind === "unknown") return [];
          return [
            { chainRef: r.chainRef, upstream: parts.namer, upstreamLocalName: parts.localName },
          ];
        });
        const statementRows = chunk(split, ROWS_PER_STATEMENT).filter((p) => p.length > 0);
        // 一批 50 条语句;**批与批之间顺序跑** —— 这是写路径(几万行),并发只会让 D1 更容易
        // 撞上限,而 cron 不赶时间。
        return Effect.forEach(
          chunk(statementRows, STATEMENTS_PER_BATCH),
          (batch) =>
            client.batch((db) =>
              batch.map((part) =>
                db
                  .insert(globalTokenRefIndex)
                  .values(part.map((r) => ({ ...r, updatedAt })))
                  // 冲突时用 `excluded`(本次要插的那一行)—— 多行语句里没法逐行写死值。
                  .onConflictDoUpdate({
                    target: [globalTokenRefIndex.chainRef, globalTokenRefIndex.upstream],
                    set: {
                      upstreamLocalName: sql`excluded.upstream_local_name`,
                      updatedAt: sql`excluded.updated_at`,
                    },
                  }),
              ),
            ),
          { discard: true },
        );
      }),

    // 上游最近一次成功刷新的时刻。从未刷过 → `none`(首次部署要手动触发一次)。
    // 取该上游所有行里最大的 updated_at —— 不另存标记行,少一处可能与真实数据不一致的状态。
    refreshedAt: (upstream: string): Effect.Effect<Option.Option<number>> =>
      Effect.map(
        client.query((db) =>
          db
            .select({ latest: max(globalTokenRefIndex.updatedAt) })
            .from(globalTokenRefIndex)
            .where(eq(globalTokenRefIndex.upstream, upstream)),
        ),
        (rows) => Option.fromNullable(rows[0]?.latest),
      ),
  };
});
