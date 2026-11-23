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

// Redaction is safeView's job (covered in creds.test); this only checks v3 record shapes.

const line = (rec: unknown) => JSON.parse(ndjsonLine(rec)); // round-trip through JSON: undefined fields disappear

describe("metaRecord", () => {
  it("v3: version=3 + app + exportedAt (first line)", () => {
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
  it("ref nested inside; null fields omitted after serialization", () => {
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
    expect(parsed).not.toHaveProperty("providerLogo"); // null → omitted
  });
});

describe("accountRecord", () => {
  it("v3 emits a platform field (not network); creds as-is", () => {
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
    expect(parsed).not.toHaveProperty("network"); // v2's network field is gone
    expect(parsed).not.toHaveProperty("data");
    expect(parsed).not.toHaveProperty("archivedAt"); // absent on active accounts
  });

  it("platform null → omitted; archivedAt set → included (archived state preserved)", () => {
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
  it("v3: balances keyed by tokenId (no symbol), metaJson parsed, selfPrice included", () => {
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
    expect(line(rec).balances[0]).not.toHaveProperty("symbol"); // v3 balances have no symbol
  });

  it("account-level note parsed back from JSON", () => {
    const rec = snapshotRecord(
      { accountId: "a", takenAt: 1, totalUsd: 0, note: JSON.stringify([{ title: "Unconfirmed" }]) },
      [],
    );
    expect(rec.note).toEqual([{ title: "Unconfirmed" }]);
  });
});

describe("manualActivityRecord", () => {
  it("flat record, createdAt kept, null fields omitted", () => {
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
