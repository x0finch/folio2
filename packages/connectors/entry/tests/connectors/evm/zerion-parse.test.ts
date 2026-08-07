import { parseChainIds } from "@folio/zerion-client";
import { describe, expect, it } from "vitest";
import { parsePositions } from "../../../src/connectors/evm/zerion-parse";
import chains from "./fixtures/zerion-chains.json";
import expected from "./fixtures/zerion-expected-balances.json";
import positions from "./fixtures/zerion-positions.json";

const chainIds = parseChainIds(chains as never);

describe("parsePositions (golden: fixtures in → fixture out)", () => {
  it("positions + chains → expected-balances(evm:<id> 标准形标识;spot 无 meta、defi 带 meta)", () => {
    const balances = parsePositions(positions, chainIds);
    expect(balances).toEqual(expected);
  });

  it("spot 行不含 meta 键(新 schema);defi 行带 meta", () => {
    const balances = parsePositions(positions, chainIds);
    for (const b of balances) {
      if (b.kind === "spot") expect("meta" in b).toBe(false);
      if (b.kind === "defi") expect(b.meta).toBeDefined();
    }
  });

  it("链映射缺失 → 抛错(失败即不产,绝不产 slug 兜底形)", () => {
    // chainIds 映射里没有某仓位的链 → 无法产规范 evm:<id> 标识 → 抛 UPSTREAM_ERROR(可重试)。
    expect(() => parsePositions(positions, {})).toThrow(/no chainId/);
  });

  it("excludes hidden/trash (displayable=false) positions", () => {
    const balances = parsePositions(positions, chainIds);
    expect(balances.find((b) => b.symbol === "SPAM")).toBeUndefined();
  });
});
