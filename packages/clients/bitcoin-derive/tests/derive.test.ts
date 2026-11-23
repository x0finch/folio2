import { describe, expect, it } from "vitest";
import { BitcoinDeriveError, blockbookXpubParam, makeDeriver, recommendedScript } from "../src";

// Offline derivation vectors (no network). The account-level key is the public key at m/purpose'/0'/0' of the standard BIP39 mnemonic
// "abandon x11 about" (empty passphrase); first addresses come from the official BIP49/84/86 test vectors (independent source), legacy from
// the same derivation path those three vectors verify; ypub/zpub are SLIP-132 variants of the same key (proving prefix conversion).
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

describe("makeDeriver: official BIP vectors (m/purpose'/0'/0'/chain/index)", () => {
  it("native SegWit (BIP84): external 0/0, 0/1, change 1/0", () => {
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

describe("makeDeriver: SLIP-132 prefixes (ypub/zpub to the same key)", () => {
  it("zpub derives native, same as the equivalent xpub", () => {
    expect(makeDeriver(ZPUB84, "native")(0, 0)).toBe(makeDeriver(XPUB84, "native")(0, 0));
  });
  it("ypub derives nested, same as the equivalent xpub", () => {
    expect(makeDeriver(YPUB49, "nested")(0, 0)).toBe(makeDeriver(XPUB49, "nested")(0, 0));
  });
});

describe("makeDeriver: script type decoupled from prefix (derives what the user picks)", () => {
  it("the same xpub with different script types gives different address prefixes", () => {
    expect(makeDeriver(XPUB44, "legacy")(0, 0)).toMatch(/^1/);
    expect(makeDeriver(XPUB44, "nested")(0, 0)).toMatch(/^3/);
    expect(makeDeriver(XPUB44, "native")(0, 0)).toMatch(/^bc1q/);
    expect(makeDeriver(XPUB44, "taproot")(0, 0)).toMatch(/^bc1p/);
  });
});

describe("recommendedScript (prefix preselection)", () => {
  it("ypub to nested, zpub to native, bare xpub to native", () => {
    expect(recommendedScript(YPUB49)).toBe("nested");
    expect(recommendedScript(ZPUB84)).toBe("native");
    expect(recommendedScript(XPUB44)).toBe("native");
  });
});

describe("makeDeriver: invalid extended key", () => {
  it("garbage string throws BitcoinDeriveError", () => {
    expect(() => makeDeriver("xpubGARBAGE", "native")).toThrow(BitcoinDeriveError);
  });
});

describe("blockbookXpubParam (builds the Blockbook token per script type)", () => {
  it("legacy/nested/native normalise to xpub/ypub/zpub prefixes (independent of the pasted prefix)", () => {
    // Whatever the input (xpub / ypub / zpub), it normalises to the SLIP-132 prefix of the chosen script type.
    expect(blockbookXpubParam(XPUB84, "native")).toBe(ZPUB84); // xpub to zpub
    expect(blockbookXpubParam(ZPUB84, "native")).toBe(ZPUB84); // zpub to zpub (as is)
    expect(blockbookXpubParam(XPUB49, "nested")).toBe(YPUB49); // xpub to ypub
    expect(blockbookXpubParam(YPUB49, "nested")).toBe(YPUB49);
    expect(blockbookXpubParam(ZPUB84, "legacy")).toMatch(/^xpub/); // zpub to xpub
  });

  it("taproot → tr(<xpub>) descriptor", () => {
    const tok = blockbookXpubParam(XPUB86, "taproot");
    expect(tok).toMatch(/^tr\(xpub.*\)$/);
  });

  it("invalid extended key throws BitcoinDeriveError", () => {
    expect(() => blockbookXpubParam("xpubGARBAGE", "native")).toThrow(BitcoinDeriveError);
  });
});
