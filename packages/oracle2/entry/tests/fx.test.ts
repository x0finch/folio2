import { describe, expect, it } from "vitest";
import { createFxRates, FX_TTL_MS, PRICE_TTL_MS, SUPPORTED_CURRENCIES } from "../src";
import { fakeCacheStore, fakeFxUpstream } from "./fakes";

// 汇率服务:**读软过期、写按 TTL**。两个动词判据不同,下面每一条都在钉这件事。

describe("resolve —— 读", () => {
  it("USD 恒 1,而且不查缓存", async () => {
    const cache = fakeCacheStore();
    const fx = createFxRates({ cache, upstream: fakeFxUpstream() });

    expect(await fx.resolve("USD")).toBe(1);
    expect(cache.entries.size).toBe(0); // 一次都没碰缓存
  });

  it("命中就给;**过期了也给** —— 汇率旧十分钟不如没有汇率糟", async () => {
    const cache = fakeCacheStore();
    const fx = createFxRates({ cache, upstream: fakeFxUpstream({ EUR: 1.09 }) });
    await fx.warm(["EUR"]);
    expect(await fx.resolve("EUR")).toBe(1.09);

    cache.now += FX_TTL_MS * 2; // 推过 TTL:条目变 stale
    expect(await fx.resolve("EUR")).toBe(1.09);
  });

  it("缓存里没有 → undefined(调用方回退 USD)", async () => {
    const fx = createFxRates({ cache: fakeCacheStore(), upstream: fakeFxUpstream() });
    expect(await fx.resolve("JPY")).toBeUndefined();
  });

  it("键归一:大小写与空格不影响读到同一条", async () => {
    const cache = fakeCacheStore();
    const fx = createFxRates({ cache, upstream: fakeFxUpstream({ EUR: 1.09 }) });
    await fx.warm(["EUR"]);
    expect(await fx.resolve("eur")).toBe(1.09);
    expect(await fx.resolve(" Eur ")).toBe(1.09);
  });

  it("USD 的短路也归一 —— 小写 usd 同样恒 1,不掉进缓存查询", async () => {
    const cache = fakeCacheStore();
    const fx = createFxRates({ cache, upstream: fakeFxUpstream() });
    expect(await fx.resolve("usd")).toBe(1);
    expect(await fx.resolve(" Usd ")).toBe(1);
    expect(cache.entries.size).toBe(0);
  });
});

describe("warm —— 写", () => {
  it("缺失 → 拉一次并写回;全新鲜 → 零请求", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeFxUpstream({ USD: 1, EUR: 1.09 });
    const fx = createFxRates({ cache, upstream });

    await fx.warm(["USD", "EUR"]);
    expect(upstream.fetches).toBe(1);
    expect(await fx.resolve("EUR")).toBe(1.09);

    await fx.warm(["USD", "EUR"]);
    expect(upstream.fetches).toBe(1); // 都新鲜,不再出网
  });

  it("过期 → 再拉一次", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeFxUpstream({ EUR: 1.09 });
    const fx = createFxRates({ cache, upstream });

    await fx.warm(["EUR"]);
    cache.now += FX_TTL_MS + 1;
    await fx.warm(["EUR"]);
    expect(upstream.fetches).toBe(2);
  });

  it("只要 USD → 无目标,一次都不出网", async () => {
    const upstream = fakeFxUpstream({ EUR: 1.09 });
    await createFxRates({ cache: fakeCacheStore(), upstream }).warm(["USD"]);
    expect(upstream.fetches).toBe(0);
  });

  it("USD 不进新鲜度判断 —— 否则「全都新鲜」永远判不成立", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeFxUpstream({ USD: 1, EUR: 1.09 });
    const fx = createFxRates({ cache, upstream });

    await fx.warm(["USD", "EUR"]);
    await fx.warm(["USD", "EUR"]);
    await fx.warm(["USD", "EUR"]);
    expect(upstream.fetches).toBe(1);
    expect(cache.entries.has("fx:USD")).toBe(false); // USD 压根不落缓存
  });

  it("一次响应里的**其余币种一并写上** —— 反正都在同一份里,下次别人切过去就是热的", async () => {
    const cache = fakeCacheStore();
    const upstream = fakeFxUpstream({ USD: 1, EUR: 1.09, JPY: 0.0067 });
    const fx = createFxRates({ cache, upstream });

    await fx.warm(["EUR"]); // 只点名要 EUR
    expect(await fx.resolve("JPY")).toBe(0.0067);
    expect(upstream.fetches).toBe(1);
  });

  it("**一个批次写回** —— 十来个币种一次 D1,不是十来次往返", async () => {
    const cache = fakeCacheStore();
    const rates = Object.fromEntries(SUPPORTED_CURRENCIES.map((c, i) => [c.code, i + 1]));
    const fx = createFxRates({ cache, upstream: fakeFxUpstream(rates) });

    await fx.warm();
    expect(cache.writes).toBe(1);
  });

  it("新鲜度判断也是**一次批量读**,不是逐币种点查", async () => {
    const cache = fakeCacheStore();
    const fx = createFxRates({ cache, upstream: fakeFxUpstream({ EUR: 1.09, JPY: 0.0067 }) });
    await fx.warm(["EUR", "JPY"]);
    const before = cache.reads;

    await fx.warm(["EUR", "JPY"]); // 都新鲜 → 只为判断读了一次
    expect(cache.reads - before).toBe(1);
  });

  it("缺省预热全部支持币种", async () => {
    const cache = fakeCacheStore();
    const rates = Object.fromEntries(SUPPORTED_CURRENCIES.map((c, i) => [c.code, i + 1]));
    const fx = createFxRates({ cache, upstream: fakeFxUpstream(rates) });

    await fx.warm();
    // 除 USD 之外全都写上了。
    expect(cache.entries.size).toBe(SUPPORTED_CURRENCIES.length - 1);
  });

  it("上游不认识的币种不出现 → 那一条仍取不到,不写脏值", async () => {
    const cache = fakeCacheStore();
    const fx = createFxRates({ cache, upstream: fakeFxUpstream({ EUR: 1.09 }) });

    await fx.warm(["EUR", "KRW"]);
    expect(await fx.resolve("KRW")).toBeUndefined();
  });

  it("小写币种也归一 —— 否则 usd 既不短路又永不落缓存,每次预热白拉一趟", async () => {
    const upstream = fakeFxUpstream({ USD: 1, EUR: 1.09 });
    const fx = createFxRates({ cache: fakeCacheStore(), upstream });

    await fx.warm(["usd"]); // 归一成 USD → 无目标
    expect(upstream.fetches).toBe(0);

    await fx.warm(["eur"]);
    await fx.warm(["EUR"]); // 上一次写的就是 fx:EUR → 这次判新鲜
    expect(upstream.fetches).toBe(1);
  });

  it("上游抛错**往上抛** —— 调用方(预热 / 首次切币种)自己决定怎么降级", async () => {
    const upstream = fakeFxUpstream();
    upstream.fetchRates = async () => {
      throw new Error("429");
    };
    await expect(
      createFxRates({ cache: fakeCacheStore(), upstream }).warm(["EUR"]),
    ).rejects.toThrow("429");
  });
});

// 这个 TTL 是本片唯一改了数值的东西(30min → 6h),而 30min 那个数是**币价**的 TTL。
// 汇率一天动千分之几 —— 钉住「它属于慢变那一档」,别哪天又被抄回价格那一档。
describe("TTL 的量级", () => {
  it("汇率的 TTL 数量级上属于慢变数据,不与长尾币价同档", () => {
    expect(FX_TTL_MS).toBeGreaterThan(PRICE_TTL_MS * 4);
  });
});
