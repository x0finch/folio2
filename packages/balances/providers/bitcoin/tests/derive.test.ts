import { describe, expect, it } from "vitest";
import { makeDeriver, recommendedScript } from "../src/derive";

// 离线派生向量(不联网)。账户级扩展公钥 = 标准 BIP39 助记词 "abandon×11 about"(空密码)在
// m/purpose'/0'/0' 的公钥;首地址取自 BIP49/84/86 官方测试向量(独立事实源),legacy 由已被三条官方
// 向量验证正确的同一派生路径产出。ypub/zpub 为同一密钥的 SLIP-132 变体(证明前缀转换)。
const XPUB44 =
  "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";
const XPUB49 =
  "xpub6C6nQwHaWbSrzs5tZ1q7m5R9cPK9eYpNMFesiXsYrgc1P8bvLLAet9JfHjYXKjToD8cBRswJXXbbFpXgwsswVPAZzKMa1jUp2kVkGVUaJa7";
const XPUB84 =
  "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
const XPUB86 =
  "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
const YPUB49 =
  "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP";
const ZPUB84 =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

describe("makeDeriver — 官方 BIP 向量(m/purpose'/0'/0'/chain/index)", () => {
  it("native SegWit(BIP84):外部 0/0、0/1、找零 1/0", () => {
    const d = makeDeriver(XPUB84, "native");
    expect(d(0, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(d(0, 1)).toBe("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    expect(d(1, 0)).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
  });

  it("nested SegWit(BIP49):0/0", () => {
    expect(makeDeriver(XPUB49, "nested")(0, 0)).toBe("37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf");
  });

  it("taproot(BIP86):0/0", () => {
    expect(makeDeriver(XPUB86, "taproot")(0, 0)).toBe(
      "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
    );
  });

  it("legacy(BIP44):0/0", () => {
    expect(makeDeriver(XPUB44, "legacy")(0, 0)).toBe("1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA");
  });
});

describe("makeDeriver — SLIP-132 前缀(ypub/zpub → 同密钥)", () => {
  it("zpub 派生 native 与等价 xpub 一致", () => {
    expect(makeDeriver(ZPUB84, "native")(0, 0)).toBe(makeDeriver(XPUB84, "native")(0, 0));
  });
  it("ypub 派生 nested 与等价 xpub 一致", () => {
    expect(makeDeriver(YPUB49, "nested")(0, 0)).toBe(makeDeriver(XPUB49, "nested")(0, 0));
  });
});

describe("makeDeriver — 脚本类型与前缀解耦(用户选什么就派生什么)", () => {
  it("同一 xpub 不同脚本类型 → 不同地址前缀", () => {
    expect(makeDeriver(XPUB44, "legacy")(0, 0)).toMatch(/^1/);
    expect(makeDeriver(XPUB44, "nested")(0, 0)).toMatch(/^3/);
    expect(makeDeriver(XPUB44, "native")(0, 0)).toMatch(/^bc1q/);
    expect(makeDeriver(XPUB44, "taproot")(0, 0)).toMatch(/^bc1p/);
  });
});

describe("recommendedScript(前缀预选)", () => {
  it("ypub→nested、zpub→native、裸 xpub→native", () => {
    expect(recommendedScript(YPUB49)).toBe("nested");
    expect(recommendedScript(ZPUB84)).toBe("native");
    expect(recommendedScript(XPUB44)).toBe("native");
  });
});

describe("makeDeriver — 非法扩展公钥", () => {
  it("乱串 → 抛 INVALID_CREDENTIALS", () => {
    expect(() => makeDeriver("xpubGARBAGE", "native")).toThrow(/invalid extended public key/);
  });
});
