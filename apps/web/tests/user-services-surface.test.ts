import { Database } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { CacheStore, TokenPriceStore, TokenStore } from "@folio/oracle-basic/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { UserServices } from "@/lib/server/runtime";

// **handler 能看见什么** —— 这条钉的是可见面本身,不是某个 handler(#504 T17)。
//
// 参考层的四个端口曾经整组露在 `UserServices` 里,于是任何 handler 都能 `yield* TokenStore`
// 直接改代币行、绕过参考层。真正要露的只有一个:DeFi 协议图那份 per-user 缓存
//(`logos/store.ts` —— 没有上游、不出网,不属于参考层)。
//
// 断言写成**类型层**的:`R` 落在 `UserServices` 里的 effect 编译得过,落在外面的编译不过。
// 运行时那张 layer 里八个端口其实都在(`provideMerge` 一并透出),收窄靠的就是这个类型。
describe("UserServices 的面", () => {
  it("聚合两张门票 + CacheStore 在里面", () => {
    const inSurface: Effect.Effect<unknown, never, UserServices>[] = [
      Effect.flatMap(Database, (db) => db.accounts.list()),
      Effect.flatMap(Oracle, (o) => o.fx.warm([])),
      Effect.flatMap(CacheStore, (c) => c.get("defi-logo:aave")),
    ];
    expect(inSurface).toHaveLength(3);
  });

  it("另外三个端口不在 —— 取它们的 effect 不是 UserServices 的 effect", () => {
    // @ts-expect-error TokenStore 不在 handler 的可见面里(#504 T17)
    const tokens: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(TokenStore, (s) =>
      s.getByIds([]),
    );
    // @ts-expect-error TokenPriceStore 同上
    const prices: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(
      TokenPriceStore,
      (s) => s.getByIds([]),
    );
    expect([tokens, prices]).toHaveLength(2);
  });
});
