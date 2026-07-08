import { validateCredentials } from "@folio/balances-basic";
import { describe, expect, it } from "vitest";
import { ACCOUNT_TYPE_SPECS, accountInputs } from "../src/account-types";

// accountType 数据约束层(ADR 0009 层1):账户输入 schema 的事实源。校验行为原属各 provider,
// 随两层重构上移到此(provider 不再声明 inputs)。

describe("ACCOUNT_TYPE_SPECS 账户输入声明", () => {
  it("覆盖现有全部 9 个类型,均声明 balance facet", () => {
    expect(Object.keys(ACCOUNT_TYPE_SPECS).sort()).toEqual(
      [
        "exchange_binance",
        "exchange_okx",
        "manual",
        "onchain_bitcoin",
        "onchain_cosmos",
        "onchain_evm",
        "onchain_solana",
        "onchain_sui",
        "perp_hyperliquid",
      ].sort(),
    );
    for (const spec of Object.values(ACCOUNT_TYPE_SPECS)) {
      expect(spec?.facets).toContain("balance");
    }
  });

  it("字段形状:evm=地址;okx=key/secret/passphrase;manual=5 字段", () => {
    expect(accountInputs("onchain_evm").map((i) => i.key)).toEqual(["identifier"]);
    expect(accountInputs("exchange_okx").map((i) => [i.key, i.type])).toEqual([
      ["apiKey", "semi"],
      ["secret", "secret"],
      ["passphrase", "secret"],
    ]);
    expect(accountInputs("manual").map((i) => i.key)).toEqual([
      "symbol",
      "amount",
      "unitPrice",
      "identifier",
      "fixed",
    ]);
  });
});

describe("bitcoin identifier validator(上移自 provider)", () => {
  const accept = (id: string, extra: Record<string, string> = {}) =>
    validateCredentials(accountInputs("onchain_bitcoin"), { identifier: id, ...extra });
  const ZPUB84 =
    "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

  it("接受地址 + zpub;scriptType 可选", async () => {
    await expect(accept("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).resolves.toBeDefined();
    await expect(accept("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).resolves.toBeDefined();
    await expect(accept(ZPUB84)).resolves.toBeDefined();
    await expect(
      accept("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", { scriptType: "taproot" }),
    ).resolves.toBeDefined();
  });

  it("拒绝 EVM 0x / 乱串", async () => {
    await expect(accept("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).rejects.toThrow(
      /identifier/,
    );
    await expect(accept("not-an-address")).rejects.toThrow(/identifier/);
  });
});

describe("manual amount/unitPrice 强制为 number(z.coerce)", () => {
  it("字符串数值被 coerce", async () => {
    const out = await validateCredentials(accountInputs("manual"), {
      symbol: "BTC",
      amount: "1.5",
      unitPrice: "60000",
    });
    expect(out.amount).toBe(1.5);
    expect(out.unitPrice).toBe(60000);
  });
});
