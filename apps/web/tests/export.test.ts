import { describe, expect, it } from "vitest";
import {
  accountRecord,
  EXPORT_VERSION,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
} from "../src/lib/export";

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

describe("accountRecord (red line: no secrets)", () => {
  const account = {
    id: "a1",
    type: "exchange_okx",
    network: null,
    label: "OKX",
    dataJson: null,
  };
  it("strips secret keys, keeps non-secret (identifier)", () => {
    const rec = accountRecord(
      { ...account, type: "onchain_evm" },
      { identifier: "0xabc", apiKey: "K", secret: "S" },
      ["apiKey", "secret", "passphrase"],
    );
    expect(rec.creds).toEqual({ identifier: "0xabc" });
    const line = ndjsonLine(rec);
    expect(line).not.toContain("apiKey");
    expect(line).not.toContain('"K"');
    expect(line).not.toContain('"S"');
    expect(line.endsWith("\n")).toBe(true);
  });
  it("CEX account → creds becomes empty after stripping", () => {
    const rec = accountRecord(account, { apiKey: "K", secret: "S", passphrase: "P" }, [
      "apiKey",
      "secret",
      "passphrase",
    ]);
    expect(rec.creds).toEqual({});
    expect(ndjsonLine(rec)).not.toContain('"P"');
  });
  it("parses dataJson (manual holdings)", () => {
    const rec = accountRecord(
      { id: "m", type: "manual", network: null, label: "M", dataJson: '{"holdings":[]}' },
      {},
      [],
    );
    expect(rec.data).toEqual({ holdings: [] });
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
        source: "ethereum",
        metaJson: '{"chain":"ethereum"}',
      },
    ]);
    expect(rec).toMatchObject({ type: "snapshot", accountId: "a1", takenAt: 1000, totalUsd: 50 });
    expect(rec.balances[0]).toMatchObject({ symbol: "ETH", meta: { chain: "ethereum" } });
  });
});
