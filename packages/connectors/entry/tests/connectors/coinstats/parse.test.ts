import { describe, expect, it } from "vitest";
import { parseBalances } from "../../../src/connectors/coinstats/parse";
import cosmosFixture from "./fixtures/cosmos.json";
import cosmosExpected from "./fixtures/expected-cosmos.json";
import solanaExpected from "./fixtures/expected-solana.json";
import suiExpected from "./fixtures/expected-sui.json";
import solanaFixture from "./fixtures/solana.json";
import suiFixture from "./fixtures/sui.json";

// golden 按链分开:每条链一份「录制的 wallet/balance 响应(输入)→ 结构化预期(输出)」,
// 用该链的 connectionId 作 fallbackChain 调 parseBalances,期望固化在文件里逐一对比。
// 覆盖:value=amount*price、kind=spot、每条 coin 自带 chain、null price→0、
// 原生币(无 contract)→ 无 tokenRef、跳过无 symbol;以及【无 chain 的 coin 退化按 fallbackChain 归链】。
describe("parseBalances — 按链 golden(fixture in → fixture out)", () => {
  it("solana(含跳过无 symbol 一条)", () => {
    const out = parseBalances(solanaFixture, "solana");
    expect(out).toEqual(solanaExpected);
    expect(out.every((b) => b.symbol.length > 0)).toBe(true); // 无空 symbol
  });

  it("sui(connectionId=sui-wallet;无 chain 的合约币退化按 fallbackChain 归链 → chain:sui-wallet/…)", () => {
    // sui 的 connectionId 是 "sui-wallet"(非 "sui")。无 chain 字段的 coin 走 fallbackChain,
    // 故 tokenRef 归到 chain:sui-wallet(behavior-preserving:与旧 @folio/balances 一致)。
    expect(parseBalances(suiFixture, "sui-wallet")).toEqual(suiExpected);
  });

  it("cosmos", () => {
    expect(parseBalances(cosmosFixture, "cosmos")).toEqual(cosmosExpected);
  });
});
