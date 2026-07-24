import { describe, expect, it } from "vitest";
import { formatTokenRef, parseTokenRef, type TokenRef } from "../src/index";

describe("formatTokenRef", () => {
  it("builds the three localName shapes", () => {
    expect(
      formatTokenRef({
        kind: "contract",
        namer: "eip155:42161",
        assetNs: "erc20",
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      }),
    ).toBe("eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(formatTokenRef({ kind: "native", namer: "bitcoin" })).toBe("bitcoin/native");
    expect(formatTokenRef({ kind: "opaque", namer: "coingecko", id: "usd-coin" })).toBe(
      "coingecko/usd-coin",
    );
  });

  it("lowercases the addressing parts (namer / assetNs / address)", () => {
    expect(
      formatTokenRef({ kind: "contract", namer: "Solana", assetNs: "TOKEN", address: "0xAbC" }),
    ).toBe("solana/token:0xabc");
    expect(formatTokenRef({ kind: "native", namer: "Bitcoin" })).toBe("bitcoin/native");
  });

  // 归一属于生产者(币安 connector 自己保证 symbol 大写);本包对不透明 id 一个字不动。
  it("passes opaque ids through untouched", () => {
    expect(formatTokenRef({ kind: "opaque", namer: "binance", id: "USDC" })).toBe("binance/USDC");
    expect(formatTokenRef({ kind: "opaque", namer: "coingecko", id: "Wrapped-BTC" })).toBe(
      "coingecko/Wrapped-BTC",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(formatTokenRef({ kind: "native", namer: "  bitcoin  " })).toBe("bitcoin/native");
  });
});

describe("parseTokenRef", () => {
  it("parses the three localName shapes", () => {
    expect(parseTokenRef("eip155:42161/erc20:0xaf88")).toEqual({
      kind: "contract",
      namer: "eip155:42161",
      assetNs: "erc20",
      address: "0xaf88",
    });
    expect(parseTokenRef("bitcoin/native")).toEqual({ kind: "native", namer: "bitcoin" });
    expect(parseTokenRef("coingecko/usd-coin")).toEqual({
      kind: "opaque",
      namer: "coingecko",
      id: "usd-coin",
    });
    expect(parseTokenRef("binance/USDC")).toEqual({
      kind: "opaque",
      namer: "binance",
      id: "USDC",
    });
  });

  // 左段对本包不透明:不判断链 / 场馆 / 数据源,`eip155:42161` 里的冒号不参与切分。
  it("splits on the first slash only and keeps the namer opaque", () => {
    expect(parseTokenRef("eip155:1/erc721:0xabc/42")).toEqual({
      kind: "contract",
      namer: "eip155:1",
      assetNs: "erc721",
      address: "0xabc/42",
    });
  });

  it("normalizes addressing parts on the way in", () => {
    expect(parseTokenRef("Solana/TOKEN:0xAbC")).toEqual({
      kind: "contract",
      namer: "solana",
      assetNs: "token",
      address: "0xabc",
    });
  });

  it("keeps opaque ids verbatim", () => {
    expect(parseTokenRef("binance/USDC")).toMatchObject({ id: "USDC" });
  });
});

describe("parseTokenRef — unknown", () => {
  it("never throws, and reports unparseable input as unknown", () => {
    for (const raw of ["", "   ", "/", "/native", "bitcoin/", "eip155:1", "nonsense", "a:b:c"]) {
      expect(() => parseTokenRef(raw)).not.toThrow();
      expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  // `native` 是保留字,只作完整 localName 出现 —— 接了冒号就不是合法合约形,判 unknown
  // 而非静默读成一个 assetNs="native" 的合约。
  it("rejects the colon form of the native reserved word", () => {
    for (const raw of ["bitcoin/native:btc", "eip155:1/native:eth"]) {
      expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  // 旧文法一律不认 —— 读旧串是迁移那一片的事,不在本包。
  it("does not accept the old grammar", () => {
    for (const raw of ["chain:bitcoin/native:btc", "coingecko:usd-coin"]) {
      expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
    }
    // `chain:` 前缀没有特殊待遇,原样留在 namer 里 —— 与规范形的 `solana` 是两个不同的命名者。
    expect(parseTokenRef("chain:solana/token:0xabc")).toMatchObject({ namer: "chain:solana" });
  });
});

describe("round-trip", () => {
  it("format ∘ parse is identity on canonical strings", () => {
    for (const s of [
      "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "eip155:1/native",
      "bitcoin/native",
      "solana/token:so11111111111111111111111111111111111111112",
      "coingecko/usd-coin",
      "binance/USDC",
      "hyperliquid/BTC",
    ]) {
      const parsed = parseTokenRef(s);
      expect(parsed.kind).not.toBe("unknown");
      expect(formatTokenRef(parsed as TokenRef)).toBe(s);
    }
  });

  it("parse ∘ format is identity on canonical refs", () => {
    const refs: TokenRef[] = [
      { kind: "contract", namer: "eip155:1", assetNs: "erc20", address: "0xabc" },
      { kind: "native", namer: "bitcoin" },
      { kind: "opaque", namer: "coingecko", id: "usd-coin" },
    ];
    for (const ref of refs) expect(parseTokenRef(formatTokenRef(ref))).toEqual(ref);
  });

  it("normalization is idempotent", () => {
    const once = parseTokenRef("Solana/TOKEN:0xAbC");
    const twice = parseTokenRef(formatTokenRef(once as TokenRef));
    expect(twice).toEqual(once);
  });
});
