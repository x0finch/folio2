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

  // 出口是**per-user 的服务**(ADR 0037):Tag + layer 成对出,方法签名里没有 userId。
  // 过渡期那层 `createDb(env)` 门面已在 #394 T8 删掉 —— 它一走,「每次调用各装一次 layer」
  // 这条路在类型上就不存在了,而不是靠人记得别用。
  it("exposes per-user store services + global infra, not a facade or raw query functions", () => {
    expect(surface.createDb).toBeUndefined();
    expect(typeof db.AccountStore).toBe("object");
    expect(typeof db.accountStoreLayer).toBe("function");
    // 非 userId 作用域的全局 infra:独立导出。
    expect(typeof db.createAuthAdapter).toBe("function");
    // 原始 query 函数不直接导出 —— 只能经服务拿到。
    expect(surface.createAccount).toBeUndefined();
    expect(surface.writeSnapshot).toBeUndefined();
    expect(surface.getLatestSnapshotByUser).toBeUndefined();
  });
});
