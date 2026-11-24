import { describe, expect, it } from "vitest";
import * as contract from "../src";
import { dayBucketOf, MS_PER_DAY, normalizeSymbol } from "../src";

// The contract layer has only types, ports and constants; this pins that it must not know any data source.

describe("this layer knows no upstream", () => {
  it("the export surface has no data source's name", () => {
    const vendorish = /cgk|coingecko|coinmarketcap|\bcmc\b|coin_?id|zerion|coinstats/i;
    const offenders = Object.keys(contract).filter((k) => vendorish.test(k));
    expect(offenders).toEqual([]);
  });

  it("`namer` is reported by the injected upstream; the contract layer presets no value", () => {
    // A `CGK_NAMER`-like constant appearing here would turn the case above red; this one pins that no default exists.
    const values = Object.values(contract).filter((v) => typeof v === "string");
    expect(values.filter((v) => /coingecko|coinmarketcap/i.test(v))).toEqual([]);
  });
});

describe("day buckets", () => {
  it("cut by UTC day; bucket start = bucket x one day", () => {
    const noon = Date.UTC(2023, 10, 14, 12);
    const bucket = dayBucketOf(noon);
    expect(bucket).toBe(Math.floor(noon / MS_PER_DAY));
    expect(bucket * MS_PER_DAY).toBe(Date.UTC(2023, 10, 14));
    // Any two moments in one day land in one bucket; across midnight they differ.
    expect(dayBucketOf(Date.UTC(2023, 10, 14, 23, 59))).toBe(bucket);
    expect(dayBucketOf(Date.UTC(2023, 10, 15))).toBe(bucket + 1);
  });
});

describe("symbol normalisation (the store keys by key only; normalisation is the caller's)", () => {
  it("trim + uppercase", () => {
    expect(normalizeSymbol("  usdc ")).toBe("USDC");
    expect(normalizeSymbol("BTC")).toBe("BTC");
  });
});
