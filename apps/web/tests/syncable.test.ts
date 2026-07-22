import type { AccountSafe } from "@folio/db";
import { describe, expect, it } from "vitest";
import { isSyncableAccount } from "../src/lib/syncable";

type A = Pick<AccountSafe, "archivedAt" | "connectorId">;
const a = (over: Partial<A>): A => ({ archivedAt: null, connectorId: "bitcoin", ...over });

describe("isSyncableAccount", () => {
  it("活跃的非-manual 账户可同步", () => {
    expect(isSyncableAccount(a({ connectorId: "bitcoin" }))).toBe(true);
    expect(isSyncableAccount(a({ connectorId: "evm" }))).toBe(true);
  });

  it("manual 不是同步源(ADR 0018)→ 排除", () => {
    expect(isSyncableAccount(a({ connectorId: "manual" }))).toBe(false);
  });

  it("归档账户排除(即便非 manual)", () => {
    expect(isSyncableAccount(a({ connectorId: "bitcoin", archivedAt: 123 }))).toBe(false);
  });
});
