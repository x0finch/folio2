import { parseChainIds } from "@folio/zerion-client";
import { describe, expect, it } from "vitest";
import { parsePositions } from "../../../src/connectors/evm/zerion-parse";
import chains from "./fixtures/zerion-chains.json";
import expected from "./fixtures/zerion-expected-balances.json";
import positions from "./fixtures/zerion-positions.json";

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
