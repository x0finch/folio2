import { describe, expect, it } from "vitest";
import * as contract from "../src";
import {
  dayBucketOf,
  INFO_TTL_MS,
  MS_PER_DAY,
  normalizeSymbol,
  PLATFORM_TTL_MS,
  PRICE_TTL_MS,
  WARM_TTL_MS,
} from "../src";

// 契约层只有类型、端口与常量(无逻辑函数)。这里钉的是「常量之间的关系」与
// 「这一层不许认识任何数据源」—— 后者是 ADR 0023 的立身之本,值得有个守卫。

describe("这一层不认识任何上游", () => {
  it("导出面里没有数据源的名字", () => {
    const vendorish = /cgk|coingecko|coinmarketcap|\bcmc\b|coin_?id|zerion|coinstats/i;
    const offenders = Object.keys(contract).filter((k) => vendorish.test(k));
    expect(offenders).toEqual([]);
  });

  it("`namer` 由注入的上游自报,契约层不预设值", () => {
    // 若哪天这里冒出一个 `CGK_NAMER` 之类的常量,上面那条会先红;这条钉的是没有默认值可用。
    const values = Object.values(contract).filter((v) => typeof v === "string");
    expect(values.filter((v) => /coingecko|coinmarketcap/i.test(v))).toEqual([]);
  });
});

describe("TTL 之间的关系(混一个接口就会在同一个方法里纠缠,故切两个 store)", () => {
  it("info / 平台名图近静态 → 长;warm / 价要新鲜 → 短", () => {
    expect(INFO_TTL_MS).toBeGreaterThan(PRICE_TTL_MS);
    expect(PLATFORM_TTL_MS).toBeGreaterThan(WARM_TTL_MS);
  });
});

describe("日桶(#148 / ADR 0019)", () => {
  it("按 UTC 日切;桶起点 = bucket × 一天", () => {
    const noon = Date.UTC(2023, 10, 14, 12);
    const bucket = dayBucketOf(noon);
    expect(bucket).toBe(Math.floor(noon / MS_PER_DAY));
    expect(bucket * MS_PER_DAY).toBe(Date.UTC(2023, 10, 14));
    // 同一天的任意两刻落同一桶;跨零点则不同。
    expect(dayBucketOf(Date.UTC(2023, 10, 14, 23, 59))).toBe(bucket);
    expect(dayBucketOf(Date.UTC(2023, 10, 15))).toBe(bucket + 1);
  });
});

describe("symbol 归一(store 只按 key 存/查,归一在调用方)", () => {
  it("trim + 大写", () => {
    expect(normalizeSymbol("  usdc ")).toBe("USDC");
    expect(normalizeSymbol("BTC")).toBe("BTC");
  });
});
