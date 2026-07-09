import { describe, expect, it } from "vitest";
import {
  accountRecord,
  EXPORT_VERSION,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
} from "../src/lib/export";

// 注:脱敏(secret 剥 / semi 打码 / public 留)逻辑是 lib/creds.ts safeView(在 creds.test 覆盖);
// 这里只测记录映射形状。route 把 safeView 的结果传给 accountRecord。

describe("metaRecord", () => {
  it("carries version + app + exportedAt (first line)", () => {
    expect(metaRecord(1700000000000)).toEqual({
      type: "meta",
      version: EXPORT_VERSION,
      app: "folio",
      exportedAt: 1700000000000,
    });
  });
});

describe("accountRecord", () => {
  it("attaches the (already-safe) creds (P6.6.2: manual holdings ride creds, no data field)", () => {
    const rec = accountRecord(
      { id: "m", connectorId: "manual", network: null, label: "M" },
      { symbol: "BTC", amount: "0.5", usdValue: "32000" }, // creds map 是字符串 map(route 经 safeView)
    );
    expect(rec.creds).toEqual({ symbol: "BTC", amount: "0.5", usdValue: "32000" });
    expect(rec).not.toHaveProperty("data");
    expect(ndjsonLine(rec).endsWith("\n")).toBe(true);
  });
});

describe("snapshotRecord", () => {
  it("maps balances and parses metaJson", () => {
    const rec = snapshotRecord({ accountId: "a1", takenAt: 1000, totalUsd: 50 }, [
      {
        symbol: "ETH",
        amount: 1,
        usdValue: 50,
        kind: "spot",
        metaJson: '{"chain":"ethereum"}',
      },
    ]);
    expect(rec).toMatchObject({ type: "snapshot", accountId: "a1", takenAt: 1000, totalUsd: 50 });
    expect(rec.balances[0]).toMatchObject({ symbol: "ETH", meta: { chain: "ethereum" } });
  });
});
