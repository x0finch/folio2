import type { UpstreamError } from "@folio/client-core";
import { Effect, Option } from "effect";
import { degradeTo } from "./degrade";

// SWR 编排 —— 「读本地 → 判 stale → 回源 → 写回」**只在这一个文件里成立**(ADR 0023)。
//
// 此前这套逻辑内联在 `priceOf` / `priceSeries` / `topTokens` 各一份:TTL 与 stale 语义有三处,
// 改一处忘两处;而且领域函数的单测必须连着缓存一起测。抽出来之后各能力只剩意图,SWR 只测一次。
//
// 「过期不删、读出带 stale」是全层的口径:价过期了仍然给旧值(展示先有数),同时标记可刷新。
//
// **形状是「读那个 effect 往里 pipe」,不是「三个回调装进一个 options 对象」**:后者是本仓反复
// 改掉的那个模式(client-core 的 `toFailure` / `checkBody` / `classifyOverride` 都是这么退场的)——
// 回调字段会让「这一步会失败成什么」离开类型。现在三段都是 effect 值,`fetch` 的 `UpstreamError`
// 在签名里看得见,而它被吞掉这件事由 `degradeTo` 一处负责(还会记一行日志)。

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
