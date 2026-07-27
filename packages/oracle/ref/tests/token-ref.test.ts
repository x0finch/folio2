import { describe, expect, it } from "vitest";
import { formatTokenRef, parseTokenRef, type TokenRefParts, tokenRef } from "../src";

// Solana 的真实地址 —— base58 大小写敏感,小写下去就不存在了。
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Sui 的 coin type 带 `::` —— 标记是按前缀认的,不是「含冒号就不行」。
const SUI_COIN = "0x2::sui::SUI";

describe("tokenRef constructors", () => {
  it("三种形状各一个构造函数,调用方不手写 kind", () => {
    expect(tokenRef.contract("evm:42161", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")).toBe(
      "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    );
    expect(tokenRef.native("bitcoin")).toBe("bitcoin/native");
    expect(tokenRef.opaque("coingecko", "usd-coin")).toBe("coingecko/usd-coin");
  });

  it("命名者一律小写归一", () => {
    expect(tokenRef.contract("Solana", "0xAbC")).toBe("solana/contract:0xAbC");
    expect(tokenRef.native("Bitcoin")).toBe("bitcoin/native");
  });

  // 归一属于生产者(币安 connector 自己保证 symbol 大写);本包对不透明 id 一个字不动。
  it("不透明 id 原样透传", () => {
    expect(tokenRef.opaque("binance", "USDC")).toBe("binance/USDC");
    expect(tokenRef.opaque("coingecko", "Wrapped-BTC")).toBe("coingecko/Wrapped-BTC");
  });

  it("两端空白 trim", () => {
    expect(tokenRef.native("  bitcoin  ")).toBe("bitcoin/native");
    expect(tokenRef.contract(" evm:1 ", " 0xABC ")).toBe("evm:1/contract:0xabc");
  });
});

describe("地址归一 —— 只对 EVM 小写", () => {
  it("EVM 的 hex 大小写不敏感 → 小写成稳定 key", () => {
    expect(tokenRef.contract("evm:1", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe(
      "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
  });

  // 小写 base58 / bech32 = 造出一个不存在的地址。
  it("非 EVM 的地址原样保留", () => {
    expect(tokenRef.contract("solana", SOL_USDC)).toBe(`solana/contract:${SOL_USDC}`);
    expect(tokenRef.contract("sui", SUI_COIN)).toBe(`sui/contract:${SUI_COIN}`);
  });

  it("构造与解析同一套归一", () => {
    expect(parseTokenRef(`solana/contract:${SOL_USDC}`)).toMatchObject({ address: SOL_USDC });
    expect(parseTokenRef("evm:1/contract:0xAbC")).toMatchObject({ address: "0xabc" });
  });
});

describe("parseTokenRef", () => {
  it("三种形状各自成支", () => {
    expect(parseTokenRef("evm:42161/contract:0xaf88")).toEqual({
      kind: "contract",
      namer: "evm:42161",
      address: "0xaf88",
      localName: "contract:0xaf88",
    });
    expect(parseTokenRef("bitcoin/native")).toEqual({
      kind: "native",
      namer: "bitcoin",
      localName: "native",
    });
    expect(parseTokenRef("coingecko/usd-coin")).toEqual({
      kind: "opaque",
      namer: "coingecko",
      id: "usd-coin",
      localName: "usd-coin",
    });
    expect(parseTokenRef("binance/USDC")).toEqual({
      kind: "opaque",
      namer: "binance",
      id: "USDC",
      localName: "USDC",
    });
  });

  // 左段的冒号(`evm:42161`)不参与切分 —— 切的是斜杠。
  it("命名者里的冒号不影响切分", () => {
    expect(parseTokenRef("evm:1/native")).toEqual({
      kind: "native",
      namer: "evm:1",
      localName: "native",
    });
  });

  // 标记按**前缀**认,所以地址本身带 `::` 的(Sui coin type)照样是合约。
  it("地址里可以有冒号", () => {
    expect(parseTokenRef(`sui/contract:${SUI_COIN}`)).toEqual({
      kind: "contract",
      namer: "sui",
      address: SUI_COIN,
      localName: `contract:${SUI_COIN}`,
    });
  });
});

describe("parseTokenRef —— unknown", () => {
  it("永不 throw,读不懂的一律 unknown", () => {
    for (const raw of ["", "   ", "/", "/native", "bitcoin/", "evm:1", "nonsense"]) {
      expect(() => parseTokenRef(raw)).not.toThrow();
      expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  // 三段串(NFT 的 tokenId 之类)在本文法里没有意义。
  it("不是恰好两段 → unknown", () => {
    for (const raw of ["evm:1/contract:0xabc/1234", "a/b/c"]) {
      expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  it("空地址 → unknown", () => {
    expect(parseTokenRef("evm:1/contract:")).toEqual({ kind: "unknown", raw: "evm:1/contract:" });
  });

  // **`contract:` 是唯一合法标记**:旧文法那几个词、以及任何 producer 自创的词,一律不认 ——
  // 否则「这条 ref 的 symbol 可不可信」就又变成猜的了(ADR 0020 第三轮)。
  it("别的标记一律 unknown,不静默读成带冒号的不透明 id", () => {
    for (const raw of [
      "evm:1/erc20:0xabc", // 旧文法
      "solana/token:EPjF", // 旧文法
      "bitcoin/native:btc", // 旧文法
      "evm:1/spl:0xabc", // 自创
    ]) {
      expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
    }
  });

  it("无斜杠的旧串照旧不认", () => {
    expect(parseTokenRef("coingecko:usd-coin")).toEqual({
      kind: "unknown",
      raw: "coingecko:usd-coin",
    });
  });
});

describe("round-trip", () => {
  it("format ∘ parse 在规范串上是恒等", () => {
    for (const s of [
      "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "evm:1/native",
      "bitcoin/native",
      `solana/contract:${SOL_USDC}`,
      `sui/contract:${SUI_COIN}`,
      "coingecko/usd-coin",
      "binance/USDC",
      "hyperliquid/BTC",
    ]) {
      const parsed = parseTokenRef(s);
      expect(parsed.kind).not.toBe("unknown");
      expect(formatTokenRef(parsed as TokenRefParts)).toBe(s);
    }
  });

  // 在**构造字段**上恒等,不是整个对象相等:`TokenRefParts` 是造串的入参,parse 的输出在它之上
  // 多一个 `localName`(右段的规范形,给按两列存的表用)。所以是超集,不是等号。
  it("parse ∘ format 在构造字段上是恒等", () => {
    const refs: TokenRefParts[] = [
      { kind: "contract", namer: "evm:1", address: "0xabc" },
      { kind: "contract", namer: "solana", address: SOL_USDC },
      { kind: "native", namer: "bitcoin" },
      { kind: "opaque", namer: "coingecko", id: "usd-coin" },
    ];
    for (const ref of refs) {
      const parsed = parseTokenRef(formatTokenRef(ref));
      expect(parsed).toMatchObject(ref);
      // 多出来的那一个字段也得对得上:拼回去要还原成同一个串。
      expect(
        parsed.kind !== "unknown" &&
          formatTokenRef({ namer: parsed.namer, localName: parsed.localName }),
      ).toBe(formatTokenRef(ref));
    }
  });

  it("归一幂等", () => {
    const once = parseTokenRef("EVM:1/CONTRACT:0xAbC");
    const twice = parseTokenRef(formatTokenRef(once as TokenRefParts));
    expect(twice).toEqual(once);
  });
});

// 按两列存 tokenRef 的表(`token_refs`,ADR 0022)要拆开存、读出来拼回去。拆的那一半就是
// `parseTokenRef` 的 `namer` / `localName`,拼回去是 `formatTokenRef` 的两段形。存储层因此不必认识
// `native` / `contract:`,也不必知道分隔符是斜杠 —— 它只读那两个字段,`kind` 一眼都不看。
describe("两段(namer / localName)与 formatTokenRef 的往返", () => {
  it("三种形状都给得出两段,且 join 是它的逆", () => {
    for (const s of [
      "evm:1/native",
      "bitcoin/native",
      `solana/contract:${SOL_USDC}`,
      `sui/contract:${SUI_COIN}`,
      "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "coingecko/usd-coin",
      "binance/USDC",
    ]) {
      const parts = parseTokenRef(s);
      expect(parts.kind).not.toBe("unknown");
      if (parts.kind === "unknown") continue;
      expect(formatTokenRef({ namer: parts.namer, localName: parts.localName })).toBe(s);
    }
  });

  it("给的是**规范形**,不是原样回抛 —— 表里只能有规范形", () => {
    expect(parseTokenRef("EVM:1/CONTRACT:0xAbC")).toMatchObject({
      namer: "evm:1",
      localName: "contract:0xabc",
    });
    expect(parseTokenRef("bitcoin/NATIVE")).toMatchObject({ localName: "native" });
  });

  it("localName 与那一支自己的字段一致(同一件事不该有两个说法)", () => {
    const c = parseTokenRef("evm:1/contract:0xabc");
    expect(c).toMatchObject({ kind: "contract", address: "0xabc", localName: "contract:0xabc" });
    const o = parseTokenRef("binance/USDC");
    expect(o).toMatchObject({ kind: "opaque", id: "USDC", localName: "USDC" });
  });

  it("右段可以带冒号(合约标记 / Sui 的 coin type),不会被当成第三段", () => {
    expect(parseTokenRef(`sui/contract:${SUI_COIN}`)).toMatchObject({
      namer: "sui",
      localName: `contract:${SUI_COIN}`,
    });
  });

  it("读不懂的串没有两段 → kind 为 unknown(那种串不进表)", () => {
    for (const raw of ["", "nonsense", "a/b/c", "evm:1/erc20:0xabc", "evm:1/contract:"]) {
      expect(parseTokenRef(raw).kind).toBe("unknown");
    }
  });
});
