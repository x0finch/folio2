import { describe, expect, it } from "vitest";
import {
  formatTokenRef,
  normalizeAddress,
  parseTokenRef,
  tokenRef,
  type TokenRefParts,
} from "../src";

// Solana / Bitcoin 的真实地址 —— base58 与 bech32 都大小写敏感,小写下去就不存在了。
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BTC_ADDR = "bc1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4";

describe("tokenRef constructors", () => {
  it("builds the three localName shapes without the caller writing `kind`", () => {
    expect(
      tokenRef.contract("eip155:42161", "erc20", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    ).toBe("eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(tokenRef.native("bitcoin")).toBe("bitcoin/native");
    expect(tokenRef.opaque("coingecko", "usd-coin")).toBe("coingecko/usd-coin");
  });

  it("lowercases the namer and the assetNs", () => {
    expect(tokenRef.contract("Solana", "TOKEN", "0xAbC")).toBe("solana/token:0xAbC");
    expect(tokenRef.native("Bitcoin")).toBe("bitcoin/native");
  });

  // 归一属于生产者(币安 connector 自己保证 symbol 大写);本包对不透明 id 一个字不动。
  it("passes opaque ids through untouched", () => {
    expect(tokenRef.opaque("binance", "USDC")).toBe("binance/USDC");
    expect(tokenRef.opaque("coingecko", "Wrapped-BTC")).toBe("coingecko/Wrapped-BTC");
  });

  it("trims surrounding whitespace", () => {
    expect(tokenRef.native("  bitcoin  ")).toBe("bitcoin/native");
  });
});

describe("normalizeAddress", () => {
  it("lowercases EVM hex (case-insensitive by nature)", () => {
    expect(normalizeAddress("eip155:1", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
  });

  // 小写 base58 / bech32 = 造出一个不存在的地址。
  it("leaves non-EVM addresses alone", () => {
    expect(normalizeAddress("solana", SOL_USDC)).toBe(SOL_USDC);
    expect(normalizeAddress("bitcoin", BTC_ADDR)).toBe(BTC_ADDR);
  });

  it("is applied by the constructor and by parse alike", () => {
    expect(tokenRef.contract("solana", "token", SOL_USDC)).toBe(`solana/token:${SOL_USDC}`);
    expect(parseTokenRef(`solana/token:${SOL_USDC}`)).toMatchObject({ address: SOL_USDC });
    expect(parseTokenRef("eip155:1/erc20:0xAbC")).toMatchObject({ address: "0xabc" });
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

  // 左段的冒号(`eip155:42161`)不参与切分 —— 切的是斜杠。
  it("keeps colons inside the namer", () => {
    expect(parseTokenRef("eip155:1/native")).toEqual({ kind: "native", namer: "eip155:1" });
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

  // 三段串(NFT 的 tokenId 之类)在本文法里没有意义 —— 判 unknown,而不是把 `/1234` 折进地址。
  it("rejects ids that are not exactly two segments", () => {
    for (const raw of ["eip155:1/erc721:0xabc/1234", "a/b/c"]) {
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
      `solana/token:${SOL_USDC}`,
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
      { kind: "contract", namer: "eip155:1", assetNs: "erc20", address: "0xabc" },
      { kind: "contract", namer: "solana", assetNs: "token", address: SOL_USDC },
      { kind: "native", namer: "bitcoin" },
      { kind: "opaque", namer: "coingecko", id: "usd-coin" },
    ];
    for (const ref of refs) expect(parseTokenRef(formatTokenRef(ref))).toEqual(ref);
  });

  it("normalization is idempotent", () => {
    const once = parseTokenRef("EIP155:1/ERC20:0xAbC");
    const twice = parseTokenRef(formatTokenRef(once as TokenRefParts));
    expect(twice).toEqual(once);
  });
});
