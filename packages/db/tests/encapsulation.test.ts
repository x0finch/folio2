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

  it("exposes createDb facade + global infra (auth adapter, token store), not raw query functions", () => {
    expect(typeof db.createDb).toBe("function");
    // 非 userId 作用域的全局 infra:独立导出(不进 createDb 门面)。
    expect(typeof db.createAuthAdapter).toBe("function");
    expect(typeof db.createTokenStore).toBe("function");
    expect(typeof db.createProviderConfigStore).toBe("function"); // ADR 0009:provider 全局配置覆盖表
    // 原始 query 函数不再直接导出 —— 都收进 createDb(env) 返回的实例(db.xxx)。
    expect(surface.createAccount).toBeUndefined();
    expect(surface.writeSnapshot).toBeUndefined();
    expect(surface.getLatestSnapshotByUser).toBeUndefined();
  });
});
