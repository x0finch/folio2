import { describe, expect, it } from "vitest";
import { fetchChainsEffect } from "../src/platform";
import { run, stubbing } from "./harness";

const ASSET_PLATFORMS = [
  {
    id: "arbitrum-one",
    chain_identifier: 42161,
    name: "Arbitrum One",
    image: { small: "https://cgk/arbitrum.jpg" },
  },
  { id: "solana", chain_identifier: null, name: "Solana", image: { small: "https://cgk/sol.jpg" } },
  { id: "no-image", chain_identifier: 999 }, // no name / image: degrades
];

const chains = async () =>
  new Map(
    (
      await run(
        stubbing(() => ASSET_PLATFORMS),
        fetchChainsEffect,
      )
    ).map((r) => [r.key, r]),
  );

describe("fetchChains", () => {
  it("one chain yields the short slug; with a numeric chainId also evm:<id>, same name and image", async () => {
    const byKey = await chains();

    expect(byKey.get("arbitrum-one")).toEqual({
      key: "arbitrum-one",
      name: "Arbitrum One",
      logo: "https://cgk/arbitrum.jpg",
    });
    expect(byKey.get("evm:42161")).toMatchObject({ name: "Arbitrum One" });
    expect(byKey.get("solana")).toMatchObject({ name: "Solana" });
    expect(byKey.has("evm:")).toBe(false); // null chain_identifier yields no evm key
  });

  it("falls back to the id when upstream gives no name; omits logo when no image", async () => {
    const byKey = await chains();

    expect(byKey.get("no-image")?.name).toBe("no-image");
    expect(byKey.get("no-image")?.logo).toBeUndefined();
    expect(byKey.has("evm:999")).toBe(true); // both keys still produced
  });
});
