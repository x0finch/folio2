import { type CacheEntry, type CacheStore, Database, type DbRequest } from "@folio/db";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { readDefiLogo, recordDefiLogos } from "@/lib/server/logos/store";
import { stubRequest } from "./oracle-stub";

// DeFi protocol logo URLs: sync stores the URL already in balance meta into a per-user cache, the image
// endpoint reads it back. Pins the key (`defi-logo:<protocol>`) and that round trip.

const fakeCache = () => {
  const entries = new Map<string, unknown>();
  const store: CacheStore = {
    get: (key: string) =>
      Effect.sync(() =>
        entries.has(key)
          ? Option.some<CacheEntry>({ value: entries.get(key), stale: false })
          : Option.none(),
      ),
    getMany: (keys: readonly string[]) =>
      Effect.sync(() => {
        const out = new Map<string, CacheEntry>();
        for (const k of keys)
          if (entries.has(k)) out.set(k, { value: entries.get(k), stale: false });
        return out;
      }),
    put: (key: string, value: unknown) => Effect.sync(() => void entries.set(key, value)),
    putMany: (writes: readonly { key: string; value: unknown }[]) =>
      Effect.sync(() => {
        for (const w of writes) entries.set(w.key, w.value);
      }),
  };
  return { store, entries };
};

// Fill only `cache`: the code under test touches nothing else, and filling all would hide what it uses.
const run = <A>(cache: CacheStore, effect: Effect.Effect<A, never, Database | DbRequest>) =>
  Effect.runPromise(
    stubRequest(
      Effect.provide(effect, Layer.succeed(Database, { cache } as unknown as Database["Service"])),
    ),
  );

describe("DeFi protocol logo URLs", () => {
  it("records a batch → read back per protocol; key is `defi-logo:<protocol>`", async () => {
    const { store, entries } = fakeCache();
    await run(
      store,
      recordDefiLogos([
        { protocol: "aave", logo: "https://x/aave.png" },
        { protocol: "curve", logo: "https://x/curve.png" },
      ]),
    );

    expect([...entries.keys()].sort()).toEqual(["defi-logo:aave", "defi-logo:curve"]);
    expect(await run(store, readDefiLogo("aave"))).toEqual(Option.some("https://x/aave.png"));
  });

  it("same protocol takes the first with a logo; no logo → nothing written (no negative cache)", async () => {
    const { store, entries } = fakeCache();
    await run(
      store,
      recordDefiLogos([
        { protocol: "aave", logo: "https://x/first.png" },
        { protocol: "aave", logo: "https://x/second.png" },
        { protocol: "nologo", logo: "" },
      ]),
    );

    expect(await run(store, readDefiLogo("aave"))).toEqual(Option.some("https://x/first.png"));
    expect(entries.has("defi-logo:nologo")).toBe(false);
    expect(await run(store, readDefiLogo("nologo"))).toEqual(Option.none());
  });

  it("empty input writes nothing; a non-string cached value counts as missing (no bad value on screen)", async () => {
    const { store, entries } = fakeCache();
    await run(store, recordDefiLogos([]));
    expect(entries.size).toBe(0);

    await run(store, store.put("defi-logo:weird", { nope: 1 }, 1000));
    expect(await run(store, readDefiLogo("weird"))).toEqual(Option.none());
  });
});
