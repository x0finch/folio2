import { describe, expect, it } from "vitest";
import {
  accountRecord,
  EXPORT_VERSION,
  manualActivityRecord,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
  tokenRecord,
} from "@/lib/server/io/export";

// 注:脱敏(secret 剥 / semi 打码 / public 留)逻辑是 lib/creds.ts safeView(在 creds.test 覆盖);
// 这里只测 v3 记录映射形状。route 把 safeView 的结果传给 accountRecord。

const line = (rec: unknown) => JSON.parse(ndjsonLine(rec)); // 走一遍 JSON:undefined 字段应消失

describe("metaRecord", () => {
  it("v3:version=3 + app + exportedAt(首行)", () => {
    expect(EXPORT_VERSION).toBe(3);
    expect(metaRecord(1700000000000)).toEqual({
      type: "meta",
      version: 3,
      app: "folio",
      exportedAt: 1700000000000,
    });
  });
});

describe("tokenRecord", () => {
  it("ref 嵌在里头;null 字段序列化后省略", () => {
    const rec = tokenRecord({
      id: "tk1",
      symbol: "USDC",
      name: "USD Coin",
      logo: "u.png",
      providerLogo: null,
      marketCapRank: 7,
      refs: [{ namer: "coingecko", localName: "issued:usd-coin" }],
    });
    expect(rec).toMatchObject({ type: "token", id: "tk1", symbol: "USDC", name: "USD Coin" });
    expect(rec.refs).toEqual([{ namer: "coingecko", localName: "issued:usd-coin" }]);
    const parsed = line(rec);
    expect(parsed.logo).toBe("u.png");
    expect(parsed.marketCapRank).toBe(7);
    expect(parsed).not.toHaveProperty("providerLogo"); // null → 省略
  });
});

describe("accountRecord", () => {
  it("v3 输出 platform 字段(旧名 network 已随版本提升改掉);creds 原样", () => {
    const rec = accountRecord(
      { id: "m", connectorId: "manual", platform: "manual", label: "M", archivedAt: null },
      { symbol: "BTC", amount: "0.5", usdValue: "32000" },
    );
    expect(rec).toMatchObject({
      type: "account",
      id: "m",
      connectorId: "manual",
      platform: "manual",
    });
    expect(rec.creds).toEqual({ symbol: "BTC", amount: "0.5", usdValue: "32000" });
    const parsed = line(rec);
    expect(parsed).not.toHaveProperty("network"); // v2 的旧字段名不再出现
    expect(parsed).not.toHaveProperty("data");
    expect(parsed).not.toHaveProperty("archivedAt"); // 活跃账户不带
  });

  it("platform 为 null → 省略;archivedAt 有值 → 带上(归档态保真)", () => {
    expect(
      line(
        accountRecord(
          { id: "a", connectorId: "evm", platform: null, label: "W", archivedAt: null },
          {},
        ),
      ),
    ).not.toHaveProperty("platform");
    expect(
      line(
        accountRecord(
          { id: "a", connectorId: "evm", platform: null, label: "W", archivedAt: 123 },
          {},
        ),
      ).archivedAt,
    ).toBe(123);
  });
});

describe("snapshotRecord", () => {
  it("v3:余额按 tokenId(无 symbol),解析 metaJson,带 selfPrice", () => {
    const rec = snapshotRecord({ accountId: "a1", takenAt: 1000, totalUsd: 50, note: null }, [
      {
        tokenId: "tk-eth",
        amount: 1,
        usdValue: 50,
        kind: "spot",
        selfPrice: 2500,
        platform: "evm:1",
        metaJson: '{"chain":"ethereum"}',
        note: null,
      },
    ]);
    expect(rec).toMatchObject({ type: "snapshot", accountId: "a1", takenAt: 1000, totalUsd: 50 });
    expect(rec.balances[0]).toMatchObject({
      tokenId: "tk-eth",
      amount: 1,
      usdValue: 50,
      kind: "spot",
      selfPrice: 2500,
      platform: "evm:1",
      meta: { chain: "ethereum" },
    });
    expect(line(rec).balances[0]).not.toHaveProperty("symbol"); // v3 余额不带 symbol
  });

  it("账户级 note 从 JSON 解析回来", () => {
    const rec = snapshotRecord(
      { accountId: "a", takenAt: 1, totalUsd: 0, note: JSON.stringify([{ title: "Unconfirmed" }]) },
      [],
    );
    expect(rec.note).toEqual([{ title: "Unconfirmed" }]);
  });
});

describe("manualActivityRecord", () => {
  it("扁平记录、保留 createdAt、null 字段省略", () => {
    const rec = manualActivityRecord({
      accountId: "a",
      tokenId: "tk",
      kind: "add",
      amount: 1,
      price: 60000,
      fee: null,
      occurredAt: 1000,
      memo: null,
      createdAt: 5,
    });
    expect(rec).toMatchObject({
      type: "manualActivity",
      accountId: "a",
      tokenId: "tk",
      kind: "add",
      amount: 1,
      price: 60000,
      occurredAt: 1000,
      createdAt: 5,
    });
    const parsed = line(rec);
    expect(parsed).not.toHaveProperty("fee");
    expect(parsed).not.toHaveProperty("memo");
  });
});
