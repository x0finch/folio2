import { describe, expect, it } from "vitest";
import { parseChainIds } from "../../../src/balance/zerion/api";
import { parsePositions } from "../../../src/balance/zerion/parse";
import chains from "./fixtures/chains.json";
import expected from "./fixtures/expected-balances.json";
import positions from "./fixtures/positions.json";

const chainIds = parseChainIds(chains as never);

describe("parsePositions (golden: fixtures in → fixture out)", () => {
  it("positions + chains to expected-balances (evm:<id> canonical identifiers; spot has no meta, defi has meta)", () => {
    const balances = parsePositions(positions, chainIds);
    expect(balances).toEqual(expected);
  });

  it("spot rows carry no meta key (new schema); defi rows carry meta", () => {
    const balances = parsePositions(positions, chainIds);
    for (const b of balances) {
      if (b.kind === "spot") expect("meta" in b).toBe(false);
      if (b.kind === "defi") expect(b.meta).toBeDefined();
    }
  });

  it("chain mapping missing: throws (failing means nothing is produced, never the slug fallback form)", () => {
    // A position's chain absent from the chainIds mapping cannot yield a canonical evm:<id>, so it throws UPSTREAM_ERROR (retryable).
    expect(() => parsePositions(positions, {})).toThrow(/zerion unavailable at \(chain list\)/);
  });
});

describe("parseChainIds", () => {
  it("hex external_id becomes a decimal chainId", () => {
    expect(chainIds.ethereum).toBe(1);
    expect(chainIds.base).toBe(8453); // 0x2105
  });
});
