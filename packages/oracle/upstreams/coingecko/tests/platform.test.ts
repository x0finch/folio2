import { describe, expect, it } from "vitest";
import { createCoinGeckoPlatformUpstream, fetchChainsEffect } from "../src/platform";
import { run, stubbing } from "./harness";

const ASSET_PLATFORMS = [
  {
    id: "arbitrum-one",
    chain_identifier: 42161,
    name: "Arbitrum One",
    image: { small: "https://cgk/arbitrum.jpg" },
  },
  { id: "solana", chain_identifier: null, name: "Solana", image: { small: "https://cgk/sol.jpg" } },
  { id: "no-image", chain_identifier: 999 }, // 无 name / image → 降级
];

const chains = async () =>
  new Map((await run(stubbing(() => ASSET_PLATFORMS), fetchChainsEffect)).map((r) => [r.key, r]));

describe("fetchChains", () => {
  it("一条链产短形 slug;有数字 chainId 再产 evm:<id>,两条同名同图", async () => {
    const byKey = await chains();

    expect(byKey.get("arbitrum-one")).toEqual({
      key: "arbitrum-one",
      name: "Arbitrum One",
      logo: "https://cgk/arbitrum.jpg",
    });
    expect(byKey.get("evm:42161")).toMatchObject({ name: "Arbitrum One" });
    expect(byKey.get("solana")).toMatchObject({ name: "Solana" });
    expect(byKey.has("evm:")).toBe(false); // chain_identifier 为 null → 不产 evm 键
  });

  it("上游没给名字 → 用它的 id;没给图 → 不带 logo", async () => {
    const byKey = await chains();

    expect(byKey.get("no-image")?.name).toBe("no-image");
    expect(byKey.get("no-image")?.logo).toBeUndefined();
    expect(byKey.has("evm:999")).toBe(true); // 仍然两个键都产
  });

  it("id 自报为当前上游", () => {
    expect(createCoinGeckoPlatformUpstream().id).toBe("coingecko");
  });
});
