import { Duration, Effect, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { PLATFORM_NEG_TTL_MS, PLATFORM_TTL_MS, PlatformResolver } from "../src";
import { platformKey, readPlatforms, writePlatforms } from "../src/platforms";
import { harness, now0, upstreamDown } from "./fakes";

const CHAINS = [
  { key: "evm:1", name: "Ethereum", logo: "e.png" },
  { key: "ethereum", name: "Ethereum", logo: "e.png" },
  { key: "solana", name: "Solana", logo: "s.png" },
];

const setup = () => harness({ chains: CHAINS });

describe("resolve —— 读", () => {
  it("**每个 key 都给一份展示**,而且不出网", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        yield* p.warm(["evm:1"]);

        const m = yield* p.resolve(["evm:1", "solana", "manual", "evm:999"]);
        expect(m.get("evm:1")).toEqual({ key: "evm:1", name: "Ethereum", logo: "e.png" });
        // 没预热过的一律走兜底名(slug 首字母大写;evm:<id> 没有 slug → 原样)。
        expect(m.get("solana")).toEqual({ key: "solana", name: "Solana" });
        expect(m.get("manual")).toEqual({ key: "manual", name: "Manual" });
        expect(m.get("evm:999")).toEqual({ key: "evm:999", name: "evm:999" });
      }),
    );
    expect(h.platformUpstream.fetches).toBe(1); // 只有那次 warm 出过网
  });

  it("否定缓存与「没缓存」在展示上是同一件事 —— 都给兜底名", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        yield* p.warm(["nosuchchain"]); // 上游链表里没有 → 写否定缓存
        expect((yield* p.resolve(["nosuchchain"])).get("nosuchchain")).toEqual({
          key: "nosuchchain",
          name: "Nosuchchain",
        });
      }),
    );
  });

  it("过期了也照给 —— 展示零网络,新鲜度是 warm 的事", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        yield* p.warm(["evm:1"]);

        yield* TestClock.adjust(Duration.millis(PLATFORM_TTL_MS * 2));
        expect((yield* p.resolve(["evm:1"])).get("evm:1")?.name).toBe("Ethereum");
      }),
    );
    expect(h.platformUpstream.fetches).toBe(1);
  });

  it("**一次读拿全** —— 问几个平台都只碰缓存一次", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        yield* p.warm(["evm:1", "solana"]);
        const before = h.cache.reads;

        yield* p.resolve(["evm:1", "solana", "manual", "evm:8453"]);
        expect(h.cache.reads - before).toBe(1); // 四个键,一次读 —— 这条是总览的关键路径
      }),
    );
  });

  it("空输入 → 空 Map,不碰缓存", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        const before = h.cache.reads;
        expect(yield* p.resolve([])).toEqual(new Map());
        expect(h.cache.reads).toBe(before);
      }),
    );
  });
});

describe("warm —— 写", () => {
  it("缺失 → 拉一次整张链表;全新鲜 → 零请求", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        yield* p.warm(["evm:1", "solana"]);
        expect(h.platformUpstream.fetches).toBe(1);

        yield* p.warm(["evm:1", "solana"]);
        expect(h.platformUpstream.fetches).toBe(1);
      }),
    );
  });

  it("**只写被问到的那几个键**,不是整张两百行的表", async () => {
    const h = setup();
    await h.run(Effect.flatMap(PlatformResolver, (p) => p.warm(["evm:1"])));
    expect([...h.cache.entries.keys()]).toEqual(["platform:evm:1"]); // 上游给了三条,只写这一条
  });

  it("**一个批次写回**,不是逐键往返", async () => {
    const h = setup();
    await h.run(
      Effect.flatMap(PlatformResolver, (p) => p.warm(["evm:1", "solana", "nosuchchain"])),
    );
    expect(h.cache.writes).toBe(1); // 三个键(含一条否定)一个批次
    expect([...h.cache.entries.keys()].sort()).toEqual([
      "platform:evm:1",
      "platform:nosuchchain",
      "platform:solana",
    ]);
  });

  it("上游没有这个键 → 写否定缓存(短 TTL),此后不再为它重拉整张表", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        yield* p.warm(["nosuchchain"]);
        expect(h.cache.entries.get("platform:nosuchchain")).toMatchObject({
          value: { name: null },
          expiresAt: now0 + PLATFORM_NEG_TTL_MS,
        });

        // 这才是否定缓存存在的理由:没有它,这个键会让**每一次**预热都重拉整张链表。
        yield* p.warm(["nosuchchain"]);
        expect(h.platformUpstream.fetches).toBe(1);
      }),
    );
  });

  it("否定缓存 TTL 短得多 —— 新链被收录后不用等一个月", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        yield* p.warm(["evm:1", "nosuchchain"]);

        expect(PLATFORM_NEG_TTL_MS).toBeLessThan(PLATFORM_TTL_MS);
        yield* TestClock.adjust(Duration.millis(PLATFORM_NEG_TTL_MS + 1));
        h.platformUpstream.chains = [...CHAINS, { key: "nosuchchain", name: "Somechain" }];
        yield* p.warm(["evm:1", "nosuchchain"]); // 否定的那条过期了 → 重拉

        expect((yield* p.resolve(["nosuchchain"])).get("nosuchchain")?.name).toBe("Somechain");
      }),
    );
  });

  it("过期 → 重拉并覆盖", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformResolver;
        yield* p.warm(["evm:1"]);

        yield* TestClock.adjust(Duration.millis(PLATFORM_TTL_MS + 1));
        h.platformUpstream.chains = [{ key: "evm:1", name: "Ethereum Mainnet", logo: "e2.png" }];
        yield* p.warm(["evm:1"]);

        expect(h.platformUpstream.fetches).toBe(2);
        expect((yield* p.resolve(["evm:1"])).get("evm:1")).toEqual({
          key: "evm:1",
          name: "Ethereum Mainnet",
          logo: "e2.png",
        });
      }),
    );
  });

  it("空输入 → 一次都不出网", async () => {
    const h = setup();
    await h.run(Effect.flatMap(PlatformResolver, (p) => p.warm([])));
    expect(h.platformUpstream.fetches).toBe(0);
  });

  // 迁移前 `fetchChains()` 抛错会一路抛给调用方(best-effort 的预热点靠自己 catch);
  // 现在按类型接住并记一行。**关键是它不写否定缓存** —— 那会把一条真链按「不存在」记上一天。
  it("上游挂了 → 什么都不写(**不是**写一堆否定缓存),下一轮照旧重试", async () => {
    const h = setup();
    h.platformUpstream.fail = upstreamDown();
    await h.run(Effect.flatMap(PlatformResolver, (p) => p.warm(["evm:1", "solana"])));
    expect(h.cache.entries.size).toBe(0);
    expect(h.cache.writes).toBe(0);

    h.platformUpstream.fail = undefined;
    await h.run(Effect.flatMap(PlatformResolver, (p) => p.warm(["evm:1"])));
    expect(h.cache.entries.get("platform:evm:1")).toMatchObject({ value: { name: "Ethereum" } });
  });
});

// —— 缓存那一侧(键 / 形状 / 批量)——
// 这几条直接打 `../src/platforms` 里的读写口,把假端口当参数传进去:它们的 `R` 是 `never`。
describe("缓存:键、形状、批量", () => {
  it("键是 `platform:<键>`,TTL 命中长、否定短", async () => {
    const h = setup();
    await h.run(
      writePlatforms(h.cache, [
        { key: "evm:1", entry: { name: "Ethereum", logo: "e.png" } },
        { key: "nochain", entry: { name: null } },
      ]),
    );

    expect([...h.cache.entries.keys()].sort()).toEqual(["platform:evm:1", "platform:nochain"]);
    expect(h.cache.entries.get("platform:evm:1")?.expiresAt).toBe(now0 + PLATFORM_TTL_MS);
    expect(h.cache.entries.get("platform:nochain")?.expiresAt).toBe(now0 + PLATFORM_NEG_TTL_MS);
    expect(h.cache.writes).toBe(1); // 两个键,一个批次
  });

  it("读回 `{name, logo}`;**否定缓存与「没这条」是两件事**;miss 的键不出现", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        yield* writePlatforms(h.cache, [
          { key: "bitcoin", entry: { name: "Bitcoin" } },
          // 问过、上游没有 —— 读得出来,只是没有名字。与「压根没问过」分开,
          // 否则每一次预热都要为这一个键重拉整张链表。
          { key: "nochain", entry: { name: null } },
        ]);

        const hits = yield* readPlatforms(h.cache, ["bitcoin", "nochain", "nope"]);
        expect(hits.get("bitcoin")?.entry).toEqual({ name: "Bitcoin" });
        expect(hits.get("nochain")?.entry).toEqual({ name: null });
        expect(hits.has("nope")).toBe(false);
      }),
    );
  });

  it("批量读一次往返 —— 逐键点查会把总览的 1 次 D1 变成 N 次", async () => {
    const h = setup();
    const before = h.cache.reads;
    await h.run(readPlatforms(h.cache, ["evm:1", "solana", "bitcoin"]));
    expect(h.cache.reads - before).toBe(1); // 三个键,一次读
  });

  // 缓存里躺着的可能是**上一个版本写的形状**(或者手动改过库)。走 Schema 解码,
  // 解不动就当没有 → 回源重写一份,自愈;`as` 断言的话旧形状会一路流到展示层。
  it("形状不对 → 当没有,不把坏值端上屏", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        yield* h.cache.put(platformKey("evm:1"), { nome: "Ethereum" }, PLATFORM_TTL_MS);
        expect((yield* readPlatforms(h.cache, ["evm:1"])).has("evm:1")).toBe(false);
      }),
    );
  });
});
