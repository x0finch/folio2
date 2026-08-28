import { type CacheEntry, type CacheStore, Database } from "@folio/db";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { readDefiLogo, recordDefiLogos } from "@/lib/server/logos/store";

// DeFi 协议图这一小片**搬回 app 了**(#390 review 第 4 条):它没有上游、不出网 —— 同步时把余额
// meta 里现成的 URL 记进 per-user 缓存,图片端点再读出来。所以它不属于参考层,但键没变
// (`defi-logo:<协议>`),数据也不用搬 —— 这一组就是钉那个键与那条往返。

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
    // 这一片不碰标旧(协议图没有「算旧了」这回事)—— 契约要求它在,给个 no-op。
    expire: () => Effect.void,
    putMany: (writes: readonly { key: string; value: unknown }[]) =>
      Effect.sync(() => {
        for (const w of writes) entries.set(w.key, w.value);
      }),
  };
  return { store, entries };
};

// 那片缓存现在是 `Database` 的一个字段(不再是从参考层漏出来的端口),所以假的也从那张票给。
// 只填 `cache` 一个字段:被测代码碰不到别的,填全反而会掩盖「它到底用了什么」。
const run = <A>(cache: CacheStore, effect: Effect.Effect<A, never, Database>) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.succeed(Database, { cache } as unknown as Database)),
  );

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
