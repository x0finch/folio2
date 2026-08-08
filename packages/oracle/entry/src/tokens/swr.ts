import type { UpstreamError } from "@folio/client-core";
import { Effect, Option } from "effect";

// SWR + 降级 —— 「读本地 → 判 stale → 回源 → 写回」与「上游挂了用旧值」**只在这一个文件里**
// (ADR 0023)。两个本来就绑在一起:`swr` 的回源失败走 `degradeTo`,拆开只是多一次跳转。
//
// 此前这套逻辑内联在 `priceOf` / `priceSeries` / `topTokens` 各一份:TTL 与 stale 语义有三处,
// 改一处忘两处;而且领域函数的单测必须连着缓存一起测。抽出来之后各能力只剩意图,SWR 只测一次。
//
// 「过期不删、读出带 stale」是全层的口径:价过期了仍然给旧值(展示先有数),同时标记可刷新。
//
// 迁移前降级是 6 处 `try { … } catch { /* 降级 */ }`,两个毛病:
//   · **连自己的 bug 一起吞** —— parse 写错了抛 TypeError,与一次 429 长得一模一样,静默降级
//   · **一行痕迹都不留** —— 上游整晚限流,日志里什么都没有,只有用户看到旧价
// 改成按类型接:`UpstreamError` 被接住并记一行,其余 defect 照样炸到 `runPromise`。
//
// **形状是「读那个 effect 往里 pipe」,不是「三个回调装进一个 options 对象」**:后者是本仓反复
// 改掉的那个模式 —— 回调字段会让「这一步会失败成什么」离开类型。现在三段都是 effect 值,
// `fetch` 的 `UpstreamError` 在签名里看得见,被吞掉由 `degradeTo` 一处负责。
//
// **领域中立,却住在 `tokens/`** —— `../fx` / `../platforms` 也在用。曾经独占 `internal/`,
// 但那个目录里大半只有代币在用。哪天用法开始分化,再提回共用位置。

export const degradeTo =
  <A>(at: string, fallback: A) =>
  <R>(self: Effect.Effect<A, UpstreamError, R>): Effect.Effect<A, never, R> =>
    Effect.catchAll(self, (error) => Effect.as(logDegraded(at, error), fallback));

// 只记 tag / pathname / 状态码。**`where` 刻意不带 query**(client-core 的契约),所以这一行
// 不可能出现 API key、签名或钱包地址(原则 #5 红线)。
//
// 单独导出是因为有一处不能用 `degradeTo`:预热那条路除了记一行,还要把「挂了」带回给调用方
// (`RefreshStaleReport.degraded`),所以它自己 `Effect.either` 之后调这个。
export const logDegraded = (at: string, error: UpstreamError): Effect.Effect<void> =>
  Effect.logWarning("oracle: upstream fetch failed, serving local data").pipe(
    Effect.annotateLogs({
      at,
      upstream: error.upstream,
      error: error._tag,
      where: error.where,
      status: error.status,
    }),
  );

export interface Cached<A> {
  readonly value: A;
  readonly stale: boolean;
}

/**
 * 新鲜 → 直接回,不碰上游。stale / miss → 回源 → 写回 → 回新值。
 * 上游没有 → **把旧值原样给出去**(有旧值就用旧的,没有就 `none`)—— 绝不因为刷不到而丢数据。
 * 上游失败也算「没有」:曲线与总额不该因为一次限流就崩(降级 + 记一行,不向上抛)。
 *
 * `at` 只进日志(降级发生在哪一步)。
 */
export const swr =
  <A, RF, RW>(
    at: string,
    fetch: Effect.Effect<Option.Option<A>, UpstreamError, RF>,
    write: (value: A) => Effect.Effect<void, never, RW>,
  ) =>
  <RR>(
    read: Effect.Effect<Option.Option<Cached<A>>, never, RR>,
  ): Effect.Effect<Option.Option<A>, never, RR | RF | RW> =>
    Effect.gen(function* () {
      const hit = yield* read;
      if (Option.isSome(hit) && !hit.value.stale) return Option.some(hit.value.value);

      const fetched = yield* degradeTo(at, Option.none<A>())(fetch);
      if (Option.isNone(fetched)) return Option.map(hit, (h) => h.value);

      yield* write(fetched.value);
      return fetched;
    });
