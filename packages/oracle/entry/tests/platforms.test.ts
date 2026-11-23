import { PLATFORM_NEG_TTL_MS, PLATFORM_TTL_MS } from "@folio/oracle-basic";
import { Duration, Effect, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { PlatformService, platformKey, readPlatforms, writePlatforms } from "../src/platforms";
import { harness, now0, upstreamDown } from "./fakes";

const CHAINS = [
  { key: "evm:1", name: "Ethereum", logo: "e.png" },
  { key: "ethereum", name: "Ethereum", logo: "e.png" },
  { key: "solana", name: "Solana", logo: "s.png" },
];

const setup = () => harness({ chains: CHAINS });

describe("resolve: read", () => {
  it("every key gets a display, with no network", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
        yield* p.warm(["evm:1"]);

        const m = yield* p.resolve(["evm:1", "solana", "manual", "evm:999"]);
        expect(m.get("evm:1")).toEqual({ key: "evm:1", name: "Ethereum", logo: "e.png" });
        // Unwarmed keys use the fallback name (slug capitalised; evm:<id> has no slug and shows as is).
        expect(m.get("solana")).toEqual({ key: "solana", name: "Solana" });
        expect(m.get("manual")).toEqual({ key: "manual", name: "Manual" });
        expect(m.get("evm:999")).toEqual({ key: "evm:999", name: "evm:999" });
      }),
    );
    expect(h.platformUpstream.fetches).toBe(1); // only the warm call went to the network
  });

  it('a negative cache entry and "not cached" look the same on display: both get the fallback name', async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
        yield* p.warm(["nosuchchain"]); // not in upstream's chain table: writes a negative cache entry
        expect((yield* p.resolve(["nosuchchain"])).get("nosuchchain")).toEqual({
          key: "nosuchchain",
          name: "Nosuchchain",
        });
      }),
    );
  });

  it("expired is still served: display is zero network, freshness is warm's job", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
        yield* p.warm(["evm:1"]);

        yield* TestClock.adjust(Duration.millis(PLATFORM_TTL_MS * 2));
        expect((yield* p.resolve(["evm:1"])).get("evm:1")?.name).toBe("Ethereum");
      }),
    );
    expect(h.platformUpstream.fetches).toBe(1);
  });

  it("one read gets everything: any number of platforms touches the cache once", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
        yield* p.warm(["evm:1", "solana"]);
        const before = h.cache.reads;

        yield* p.resolve(["evm:1", "solana", "manual", "evm:8453"]);
        expect(h.cache.reads - before).toBe(1); // four keys, one read: the overview's critical path
      }),
    );
  });

  it("empty input: empty Map, no cache access", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
        const before = h.cache.reads;
        expect(yield* p.resolve([])).toEqual(new Map());
        expect(h.cache.reads).toBe(before);
      }),
    );
  });
});

describe("warm: write", () => {
  it("missing: fetches the whole chain table once; all fresh: zero requests", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
        yield* p.warm(["evm:1", "solana"]);
        expect(h.platformUpstream.fetches).toBe(1);

        yield* p.warm(["evm:1", "solana"]);
        expect(h.platformUpstream.fetches).toBe(1);
      }),
    );
  });

  it("writes only the keys asked for, not the whole two-hundred-row table", async () => {
    const h = setup();
    await h.run(Effect.flatMap(PlatformService, (p) => p.warm(["evm:1"])));
    expect([...h.cache.entries.keys()]).toEqual(["platform:evm:1"]); // upstream gave three, only this one is written
  });

  it("writes back in one batch, not per-key round trips", async () => {
    const h = setup();
    await h.run(Effect.flatMap(PlatformService, (p) => p.warm(["evm:1", "solana", "nosuchchain"])));
    expect(h.cache.writes).toBe(1); // three keys (one negative) in one batch
    expect([...h.cache.entries.keys()].sort()).toEqual([
      "platform:evm:1",
      "platform:nosuchchain",
      "platform:solana",
    ]);
  });

  it("upstream lacks the key: writes a negative entry (short TTL) so later warms do not refetch the whole table", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
        yield* p.warm(["nosuchchain"]);
        expect(h.cache.entries.get("platform:nosuchchain")).toMatchObject({
          value: { name: null },
          expiresAt: now0 + PLATFORM_NEG_TTL_MS,
        });

        // That is what the negative cache is for: without it this key makes every warm refetch the table.
        yield* p.warm(["nosuchchain"]);
        expect(h.platformUpstream.fetches).toBe(1);
      }),
    );
  });

  it("the negative TTL is much shorter: a newly listed chain needs no month's wait", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
        yield* p.warm(["evm:1", "nosuchchain"]);

        expect(PLATFORM_NEG_TTL_MS).toBeLessThan(PLATFORM_TTL_MS);
        yield* TestClock.adjust(Duration.millis(PLATFORM_NEG_TTL_MS + 1));
        h.platformUpstream.chains = [...CHAINS, { key: "nosuchchain", name: "Somechain" }];
        yield* p.warm(["evm:1", "nosuchchain"]); // the negative one expired: refetch

        expect((yield* p.resolve(["nosuchchain"])).get("nosuchchain")?.name).toBe("Somechain");
      }),
    );
  });

  it("expired: refetches and overwrites", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const p = yield* PlatformService;
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

  it("empty input: no network at all", async () => {
    const h = setup();
    await h.run(Effect.flatMap(PlatformService, (p) => p.warm([])));
    expect(h.platformUpstream.fetches).toBe(0);
  });

  // Upstream failure is caught by type and logged. Crucially it writes no negative entries, which would record a real chain as nonexistent for a day.
  it("upstream down: nothing written (not a pile of negative entries), the next round retries as usual", async () => {
    const h = setup();
    h.platformUpstream.fail = upstreamDown();
    await h.run(Effect.flatMap(PlatformService, (p) => p.warm(["evm:1", "solana"])));
    expect(h.cache.entries.size).toBe(0);
    expect(h.cache.writes).toBe(0);

    h.platformUpstream.fail = undefined;
    await h.run(Effect.flatMap(PlatformService, (p) => p.warm(["evm:1"])));
    expect(h.cache.entries.get("platform:evm:1")).toMatchObject({ value: { name: "Ethereum" } });
  });
});

// Cache side (keys / shape / batching): these hit the read/write ports in `../src/platforms` directly with fake ports (`R` is `never`).
describe("cache: keys, shape, batching", () => {
  it("key is `platform:<key>`, TTL long for hits and short for negatives", async () => {
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
    expect(h.cache.writes).toBe(1); // two keys, one batch
  });

  it('reads back `{name, logo}`; a negative entry differs from "no such entry"; missing keys are absent', async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        yield* writePlatforms(h.cache, [
          { key: "bitcoin", entry: { name: "Bitcoin" } },
          // Asked, upstream has none: readable, just no name. Distinct from "never asked", or every warm refetches the table.
          { key: "nochain", entry: { name: null } },
        ]);

        const hits = yield* readPlatforms(h.cache, ["bitcoin", "nochain", "nope"]);
        expect(hits.get("bitcoin")?.entry).toEqual({ name: "Bitcoin" });
        expect(hits.get("nochain")?.entry).toEqual({ name: null });
        expect(hits.has("nope")).toBe(false);
      }),
    );
  });

  it("batched read is one round trip: per-key lookups would turn the overview's 1 D1 call into N", async () => {
    const h = setup();
    const before = h.cache.reads;
    await h.run(readPlatforms(h.cache, ["evm:1", "solana", "bitcoin"]));
    expect(h.cache.reads - before).toBe(1); // three keys, one read
  });

  // The cache may hold an older version's shape (or a hand edit): Schema-decoded, undecodable counts as absent and refetches.
  it("wrong shape: treated as absent, no bad value reaches the screen", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        yield* h.cache.put(platformKey("evm:1"), { nome: "Ethereum" }, PLATFORM_TTL_MS);
        expect((yield* readPlatforms(h.cache, ["evm:1"])).has("evm:1")).toBe(false);
      }),
    );
  });
});
