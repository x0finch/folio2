import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoinGeckoPlatformUpstream } from "../src";

// 限速闸:每个用例从干净状态出发,且 sleep 即时 —— 否则无 key 档(10 次/分钟)会让这套测试
// **真的等**,而上一个用例撞出来的冷却还会漏给下一个。生产不传 sleep(用 setTimeout)。
const NO_WAIT = { sleep: async () => {} };
// 限速闸旁路:这个文件测的不是限频。闸的行为在 @folio/shared 的单测里用假时钟验过,
// 这里让它直接放行 —— 否则每个用例都要按窗口真等。
bypassRateLimitsForTests(true);

beforeEach(() => resetRateLimitsForTests());

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

function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  } as Response);
}
afterEach(() => vi.restoreAllMocks());

describe("createCoinGeckoPlatformUpstream.fetchChains", () => {
  it("一条链产短形 slug;有数字 chainId 再产 evm:<id>,两条同名同图", async () => {
    mockFetch(ASSET_PLATFORMS);
    const byKey = new Map(
      (await createCoinGeckoPlatformUpstream(NO_WAIT).fetchChains()).map((r) => [r.key, r]),
    );

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
    mockFetch(ASSET_PLATFORMS);
    const byKey = new Map(
      (await createCoinGeckoPlatformUpstream(NO_WAIT).fetchChains()).map((r) => [r.key, r]),
    );

    expect(byKey.get("no-image")?.name).toBe("no-image");
    expect(byKey.get("no-image")?.logo).toBeUndefined();
    expect(byKey.has("evm:999")).toBe(true); // 仍然两个键都产
  });

  it("id 自报为当前上游", async () => {
    expect(createCoinGeckoPlatformUpstream(NO_WAIT).id).toBe("coingecko");
  });
});
