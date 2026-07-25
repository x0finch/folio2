import { describe, expect, it } from "vitest";
import { formatTokenRef, parseTokenRef, type TokenRefParts, tokenRef } from "../src";

// Solana / Bitcoin 的真实地址 —— base58 与 bech32 都大小写敏感,小写下去就不存在了。
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("tokenRef constructors", () => {
  it("builds the two localName shapes without the caller writing `kind`", () => {
    expect(tokenRef.local("evm:42161", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")).toBe(
      "evm:42161/0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    );
    expect(tokenRef.native("bitcoin")).toBe("bitcoin/native");
    expect(tokenRef.local("coingecko", "usd-coin")).toBe("coingecko/usd-coin");
  });

  it("lowercases the namer", () => {
    expect(tokenRef.local("Solana", "0xAbC")).toBe("solana/0xAbC");
    expect(tokenRef.native("Bitcoin")).toBe("bitcoin/native");
  });

  // 归一属于生产者(币安 connector 自己保证 symbol 大写);非 EVM 命名者的 localName 一个字不动。
  it("passes non-EVM localNames through untouched", () => {
    expect(tokenRef.local("binance", "USDC")).toBe("binance/USDC");
    expect(tokenRef.local("coingecko", "Wrapped-BTC")).toBe("coingecko/Wrapped-BTC");
  });

  it("trims surrounding whitespace", () => {
    expect(tokenRef.native("  bitcoin  ")).toBe("bitcoin/native");
    expect(tokenRef.local("  binance ", " USDC ")).toBe("binance/USDC");
  });
});

describe("localName 归一 —— 只对 EVM 小写", () => {
  it("lowercases EVM hex (case-insensitive by nature)", () => {
    expect(tokenRef.local("evm:1", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(
      "evm:1/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
  });

  // 小写 base58 / bech32 = 造出一个不存在的地址;CEX symbol 小写下去也不是同一个东西。
  it("leaves non-EVM addresses and venue symbols alone", () => {
    expect(tokenRef.local("solana", SOL_USDC)).toBe(`solana/${SOL_USDC}`);
    expect(tokenRef.local("hyperliquid", "BTC")).toBe("hyperliquid/BTC");
  });

  it("is applied by the constructor and by parse alike", () => {
    expect(parseTokenRef(`solana/${SOL_USDC}`)).toMatchObject({ localName: SOL_USDC });
    expect(parseTokenRef("evm:1/0xAbC")).toMatchObject({ localName: "0xabc" });
  });
});

describe("parseTokenRef", () => {
  it("parses the two localName shapes", () => {
    expect(parseTokenRef("evm:42161/0xaf88")).toEqual({
      kind: "local",
      namer: "evm:42161",
      localName: "0xaf88",
    });
    expect(parseTokenRef("bitcoin/native")).toEqual({ kind: "native", namer: "bitcoin" });
    expect(parseTokenRef("coingecko/usd-coin")).toEqual({
      kind: "local",
      namer: "coingecko",
      localName: "usd-coin",
    });
    expect(parseTokenRef("binance/USDC")).toEqual({
      kind: "local",
      namer: "binance",
      localName: "USDC",
    });
  });

  // 左段的冒号(`evm:42161`)不参与切分 —— 切的是斜杠。
  it("keeps colons inside the namer", () => {
    expect(parseTokenRef("evm:1/native")).toEqual({ kind: "native", namer: "evm:1" });
  });
});

describe("parseTokenRef — unknown", () => {
  it("never throws, and reports unparseable input as unknown", () => {
    for (const raw of ["", "   ", "/", "/native", "bitcoin/", "evm:1", "nonsense"]) {
      expect(() => parseTokenRef(raw)).not.toThrow();
      expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  // 三段串(NFT 的 tokenId 之类)在本文法里没有意义 —— 判 unknown,而不是把 `/1234` 折进 localName。
  it("rejects ids that are not exactly two segments", () => {
    for (const raw of ["evm:1/0xabc/1234", "a/b/c"]) {
      expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  // 收窄后本包无从分辨 localName 是地址还是不透明 id → 只要两段非空就认。旧串(`erc20:` /
  // `eip155:` / `chain:`)因此**不会**被判 unknown,而是读成一个 namer/localName 都对不上任何
  // 命名者的死串 —— 不迁移、库重建(ADR 0021),它们不会出现在数据里。
  it("no longer discriminates by shape: any two non-empty segments parse", () => {
    expect(parseTokenRef("eip155:1/erc20:0xabc")).toEqual({
      kind: "local",
      namer: "eip155:1",
      localName: "erc20:0xabc",
    });
    expect(parseTokenRef("coingecko:usd-coin")).toEqual({
      kind: "unknown",
      raw: "coingecko:usd-coin",
    }); // 无斜杠 → 结构上就读不懂
  });
});

describe("round-trip", () => {
  it("format ∘ parse is identity on canonical strings", () => {
    for (const s of [
      "evm:42161/0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "evm:1/native",
      "bitcoin/native",
      `solana/${SOL_USDC}`,
      "coingecko/usd-coin",
      "binance/USDC",
      "hyperliquid/BTC",
    ]) {
      const parsed = parseTokenRef(s);
      expect(parsed.kind).not.toBe("unknown");
      expect(formatTokenRef(parsed as TokenRefParts)).toBe(s);
    }
  });

  it("parse ∘ format is identity on canonical refs", () => {
    const refs: TokenRefParts[] = [
      { kind: "local", namer: "evm:1", localName: "0xabc" },
      { kind: "local", namer: "solana", localName: SOL_USDC },
      { kind: "native", namer: "bitcoin" },
      { kind: "local", namer: "coingecko", localName: "usd-coin" },
    ];
    for (const ref of refs) expect(parseTokenRef(formatTokenRef(ref))).toEqual(ref);
  });

  it("normalization is idempotent", () => {
    const once = parseTokenRef("EVM:1/0xAbC");
    const twice = parseTokenRef(formatTokenRef(once as TokenRefParts));
    expect(twice).toEqual(once);
  });
});
