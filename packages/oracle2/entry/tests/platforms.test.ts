import { describe, expect, it } from "vitest";
import { createPlatforms, PLATFORM_NEG_TTL_MS, PLATFORM_TTL_MS } from "../src";
import { fakeCacheStore, fakePlatformUpstream } from "./fakes";

const CHAINS = [
  { key: "evm:1", name: "Ethereum", logo: "e.png" },
  { key: "ethereum", name: "Ethereum", logo: "e.png" },
  { key: "solana", name: "Solana", logo: "s.png" },
];

describe("resolve —— 读", () => {
  it("**每个 key 都给一份展示**,而且不出网", async () => {
    const cache = fakeCacheStore();
    const upstream = fakePlatformUpstream(CHAINS);
    const p = createPlatforms({ cache, upstream });
    await p.warm(["evm:1"]);

    const m = await p.resolve(["evm:1", "solana", "manual", "evm:999"]);
    expect(m.get("evm:1")).toEqual({ key: "evm:1", name: "Ethereum", logo: "e.png" });
    // 没预热过的一律走兜底名(slug 首字母大写;evm:<id> 没有 slug → 原样)。
    expect(m.get("solana")).toEqual({ key: "solana", name: "Solana" });
    expect(m.get("manual")).toEqual({ key: "manual", name: "Manual" });
    expect(m.get("evm:999")).toEqual({ key: "evm:999", name: "evm:999" });
    expect(upstream.fetches).toBe(1); // 只有那次 warm 出过网
  });

  it("否定缓存与「没缓存」在展示上是同一件事 —— 都给兜底名", async () => {
    const cache = fakeCacheStore();
    const p = createPlatforms({ cache, upstream: fakePlatformUpstream(CHAINS) });
    await p.warm(["nosuchchain"]); // 上游链表里没有 → 写否定缓存

    expect((await p.resolve(["nosuchchain"])).get("nosuchchain")).toEqual({
      key: "nosuchchain",
      name: "Nosuchchain",
    });
  });

  it("过期了也照给 —— 展示零网络,新鲜度是 warm 的事", async () => {
    const cache = fakeCacheStore();
    const upstream = fakePlatformUpstream(CHAINS);
    const p = createPlatforms({ cache, upstream });
    await p.warm(["evm:1"]);

    cache.now += PLATFORM_TTL_MS * 2;
    expect((await p.resolve(["evm:1"])).get("evm:1")?.name).toBe("Ethereum");
    expect(upstream.fetches).toBe(1);
  });

  it("空输入 → 空 Map,不碰缓存", async () => {
    const cache = fakeCacheStore();
    const p = createPlatforms({ cache, upstream: fakePlatformUpstream(CHAINS) });
    expect(await p.resolve([])).toEqual(new Map());
  });
});

describe("warm —— 写", () => {
  it("缺失 → 拉一次整张链表;全新鲜 → 零请求", async () => {
    const cache = fakeCacheStore();
    const upstream = fakePlatformUpstream(CHAINS);
    const p = createPlatforms({ cache, upstream });

    await p.warm(["evm:1", "solana"]);
    expect(upstream.fetches).toBe(1);

    await p.warm(["evm:1", "solana"]);
    expect(upstream.fetches).toBe(1);
  });

  it("**只写被问到的那几个键**,不是整张两百行的表", async () => {
    const cache = fakeCacheStore();
    const p = createPlatforms({ cache, upstream: fakePlatformUpstream(CHAINS) });

    await p.warm(["evm:1"]);
    expect([...cache.entries.keys()]).toEqual(["platform:evm:1"]);
  });

  it("上游没有这个键 → 写否定缓存(短 TTL),此后不再为它重拉整张表", async () => {
    const cache = fakeCacheStore();
    const upstream = fakePlatformUpstream(CHAINS);
    const p = createPlatforms({ cache, upstream });

    await p.warm(["nosuchchain"]);
    expect(cache.entries.get("platform:nosuchchain")).toMatchObject({
      value: { name: null },
      expiresAt: cache.now + PLATFORM_NEG_TTL_MS,
    });

    // 这才是否定缓存存在的理由:没有它,这个键会让**每一次**预热都重拉整张链表。
    await p.warm(["nosuchchain"]);
    expect(upstream.fetches).toBe(1);
  });

  it("否定缓存 TTL 短得多 —— 新链被收录后不用等一个月", async () => {
    const cache = fakeCacheStore();
    const upstream = fakePlatformUpstream(CHAINS);
    const p = createPlatforms({ cache, upstream });
    await p.warm(["evm:1", "nosuchchain"]);

    expect(PLATFORM_NEG_TTL_MS).toBeLessThan(PLATFORM_TTL_MS);
    cache.now += PLATFORM_NEG_TTL_MS + 1;
    upstream.chains = [...CHAINS, { key: "nosuchchain", name: "Somechain" }];
    await p.warm(["evm:1", "nosuchchain"]); // 否定的那条过期了 → 重拉

    expect((await p.resolve(["nosuchchain"])).get("nosuchchain")?.name).toBe("Somechain");
  });

  it("过期 → 重拉并覆盖", async () => {
    const cache = fakeCacheStore();
    const upstream = fakePlatformUpstream(CHAINS);
    const p = createPlatforms({ cache, upstream });
    await p.warm(["evm:1"]);

    cache.now += PLATFORM_TTL_MS + 1;
    upstream.chains = [{ key: "evm:1", name: "Ethereum Mainnet", logo: "e2.png" }];
    await p.warm(["evm:1"]);

    expect(upstream.fetches).toBe(2);
    expect((await p.resolve(["evm:1"])).get("evm:1")).toEqual({
      key: "evm:1",
      name: "Ethereum Mainnet",
      logo: "e2.png",
    });
  });

  it("空输入 → 一次都不出网", async () => {
    const upstream = fakePlatformUpstream(CHAINS);
    await createPlatforms({ cache: fakeCacheStore(), upstream }).warm([]);
    expect(upstream.fetches).toBe(0);
  });
});
