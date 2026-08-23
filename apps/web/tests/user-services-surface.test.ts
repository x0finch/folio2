import { Database, DatabaseForOracle, GlobalDatabase } from "@folio/db";
import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { UserServices } from "@/lib/server/runtime";

// **handler 能看见什么** —— 这条钉的是可见面本身,不是某个 handler(#504 T17)。
//
// 参考层的代币行与价格行曾经整组露在 `UserServices` 里,于是任何 handler 都能直接改代币行、
// 绕过 mint 与 SWR 编排。现在它们只在 `DatabaseForOracle` 上,而那张票只喂给 `@folio/oracle`。
//
// 断言写成**类型层**的:`R` 落在 `UserServices` 里的 effect 编译得过,落在外面的编译不过。
describe("UserServices 的面", () => {
  it("三张门票在里面", () => {
    const inSurface: Effect.Effect<unknown, never, UserServices>[] = [
      Effect.flatMap(Database, (db) => db.accounts.list()),
      Effect.flatMap(Oracle, (o) => o.fx.warm([])),
      // app 直接用的那片 KV 缓存(DeFi 协议图)。它是 `Database` 的一个字段 ——
      // 不再是从参考层的装配里漏出来的一个端口。
      Effect.flatMap(Database, (db) => db.cache.get("defi-logo:aave")),
    ];
    expect(inSurface).toHaveLength(3);
  });

  it("参考层那张票不在 —— 取它的 effect 不是 UserServices 的 effect", () => {
    // @ts-expect-error DatabaseForOracle 不在 handler 的可见面里(#504 T17)
    const tokens: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(
      DatabaseForOracle,
      (db) => db.tokens.getByIds([]),
    );
    // @ts-expect-error 同上:价格行也只有参考层碰得到
    const prices: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(
      DatabaseForOracle,
      (db) => db.tokenPrices.getByIds([]),
    );
    expect([tokens, prices]).toHaveLength(2);
  });

  it("不带 userId 的那张票也不在 —— 它是 cron 的,不是 handler 的", () => {
    // @ts-expect-error GlobalDatabase 由 cron 侧自己装配(server.ts / withGlobalDb)
    const ids: Effect.Effect<unknown, never, UserServices> = Effect.flatMap(GlobalDatabase, (db) =>
      db.accounts.listUserIds(),
    );
    expect(ids).toBeDefined();
  });
});
