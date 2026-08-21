import type { CacheEntry } from "@folio/oracle-basic";
import { CacheStore } from "@folio/oracle-basic/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { readDefiLogo, recordDefiLogos } from "@/lib/server/logos/store";

// DeFi 协议图这一小片**搬回 app 了**(#390 review 第 4 条):它没有上游、不出网 —— 同步时把余额
// meta 里现成的 URL 记进 per-user 缓存,图片端点再读出来。所以它不属于参考层,但键没变
// (`defi-logo:<协议>`),数据也不用搬 —— 这一组就是钉那个键与那条往返。

const fakeCache = () => {
  const entries = new Map<string, unknown>();
  const store: CacheStore = {
    get: (key) =>
      Effect.sync(() =>
        entries.has(key)
          ? Option.some<CacheEntry>({ value: entries.get(key), stale: false })
          : Option.none(),
      ),
    getMany: (keys) =>
      Effect.sync(() => {
        const out = new Map<string, CacheEntry>();
        for (const k of keys)
          if (entries.has(k)) out.set(k, { value: entries.get(k), stale: false });
        return out;
      }),
    put: (key, value) => Effect.sync(() => void entries.set(key, value)),
    putMany: (writes) =>
      Effect.sync(() => {
        for (const w of writes) entries.set(w.key, w.value);
      }),
  };
  return { store, entries };
};

const run = <A>(cache: CacheStore, effect: Effect.Effect<A, never, CacheStore>) =>
  Effect.runPromise(Effect.provide(effect, Layer.succeed(CacheStore, cache)));

describe("DeFi 协议图的名址", () => {
  it("记一批 → 按协议读回;键是 `defi-logo:<协议>`", async () => {
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

  it("同协议取首个带图者;没图的不写(**没有否定缓存**)", async () => {
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

  it("空输入不写;缓存里躺着的不是字符串 → 当没有(不把坏值端上屏)", async () => {
    const { store, entries } = fakeCache();
    await run(store, recordDefiLogos([]));
    expect(entries.size).toBe(0);

    await run(store, store.put("defi-logo:weird", { nope: 1 }, 1000));
    expect(await run(store, readDefiLogo("weird"))).toEqual(Option.none());
  });
});
