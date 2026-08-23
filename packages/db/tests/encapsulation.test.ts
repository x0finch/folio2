import { describe, expect, it } from "vitest";
import * as db from "../src";

const surface = db as Record<string, unknown>;

describe("@folio/db encapsulation", () => {
  it("does not expose the drizzle instance, schema, getDb, or raw tables", () => {
    expect(surface.getDb).toBeUndefined();
    expect(surface.schema).toBeUndefined();
    expect(surface.accounts).toBeUndefined(); // no raw table handle
    expect(surface.drizzle).toBeUndefined();
  });

  // 出口是**per-user 的服务**(ADR 0037):一个名字同时是 Tag 和它的 layer(`Effect.Service`,
  // #501),方法签名里没有 userId —— 它在建服务那一刻从 `CurrentUser` 读一次(ADR 0044)。
  // 过渡期那层 `createDb(env)` 门面已在 #394 T8 删掉 —— 它一走,「每次调用各装一次 layer」
  // 这条路在类型上就不存在了,而不是靠人记得别用。
  it("exposes per-user store services + global infra, not a facade or raw query functions", () => {
    expect(surface.createDb).toBeUndefined();
    // `Effect.Service` 出来的是个 class(所以 typeof 是 function),`.Default` 是它的 layer
    // ——**不带参数**:userId 走 `CurrentUser`(ADR 0044),装配点 provide 一次。
    expect(typeof db.AccountStore).toBe("function");
    expect(typeof db.AccountStore.Default).toBe("object");
    expect(typeof db.CurrentUser).toBe("function"); // Context.Tag class
    // 非 userId 作用域的全局 infra:独立导出。
    expect(typeof db.createAuthAdapter).toBe("function");
    // 原始 query 函数不直接导出 —— 只能经服务拿到。
    expect(surface.createAccount).toBeUndefined();
    expect(surface.writeSnapshot).toBeUndefined();
    expect(surface.getLatestSnapshotByUser).toBeUndefined();
  });

  // #504 T5 的出口形状(ADR 0045)。
  it("hands out one ticket per half: Database for the domains, oraclePortsLayer for the ports", () => {
    // 八个领域一张门票,`.Default` 的 `R` 只差 `DbClient | CurrentUser`(装配点给)。
    expect(typeof db.Database).toBe("function");
    expect(typeof db.Database.Default).toBe("object");
    // **`DbClient` 只出类型不出值**(原则 #6):它的 `query` 回调参数就是 drizzle 句柄,
    // class 一旦出包,包外 `yield* DbClient` 就能绕过全部包装层拼任意查询。
    expect(surface.DbClient).toBeUndefined();
    expect(typeof db.dbClientLayer).toBe("function");
    // 参考层四个端口一张 layer;全局那张表单独可拿(cron 无 userId)。
    expect(typeof db.oraclePortsLayer).toBe("function");
    expect(typeof db.globalTokenRefIndexStoreLayer).toBe("object");
    expect(surface.userTokenStoreLayer).toBeUndefined();
    expect(surface.userCacheStoreLayer).toBeUndefined();
    // 系统级(无 userId)的那一个查询保持独立出口。它自己就是个 effect(不是工厂)——
    // 没有「谁的」这回事,所以也没有要吃的参数。
    expect(typeof db.listUserIdsWithAccounts).toBe("object");
    // 类型化失败。
    expect(typeof db.NotFound).toBe("function");
    expect(new db.NotFound({ entity: "account", id: "a1" }).message).toBe("account not found: a1");
    expect(typeof db.InvalidInput).toBe("function");
    expect(new db.InvalidInput({ what: "tab pin", why: "requires tagId" }).message).toBe(
      "tab pin: requires tagId",
    );
  });
});
