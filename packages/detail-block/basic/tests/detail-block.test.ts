import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  AddressListBlock,
  DetailBlock,
  type DetailBlockType,
  type DetailFormat,
  type StatBlock,
} from "../src/detail-block";

describe("DetailBlock v1 判别联合 —— runtime parse", () => {
  it("stat:带标签数值 + format + amount 单位(单位是数据)", () => {
    const b = DetailBlock.parse({
      type: "stat",
      label: "Overview.btcPending",
      value: 0.00012345,
      format: "amount",
      unit: "BTC",
    });
    expect(b).toMatchObject({
      type: "stat",
      value: 0.00012345,
      format: "amount",
      unit: "BTC",
    });
  });

  it("keyValue:数字项带 format、字符串项省 format;块级 label 可选", () => {
    const b = DetailBlock.parse({
      type: "keyValue",
      items: [
        { label: "Cex.locked", value: 1.5, format: "usd" },
        { label: "Cex.note", value: "n/a" },
      ],
    });
    expect(b.type).toBe("keyValue");
    if (b.type === "keyValue") {
      expect(b.label).toBeUndefined();
      expect(b.items).toHaveLength(2);
      expect(b.items[1].format).toBeUndefined();
    }
  });

  it("addressList:仅 address 必填,派生字段与 qr 可选", () => {
    const b = DetailBlock.parse({
      type: "addressList",
      label: "Overview.btcDistribution",
      qr: true,
      items: [
        {
          address: "bc1qexample",
          path: "m/84'/0'/0'/0/0",
          index: 0,
          balance: { value: 0.00005, unit: "BTC" },
        },
        { address: "bc1qonly" },
      ],
    });
    expect(b.type).toBe("addressList");
    if (b.type === "addressList") {
      expect(b.qr).toBe(true);
      expect(b.items[1].path).toBeUndefined();
    }
  });

  it("未知块 type 被拒", () => {
    expect(() => DetailBlock.parse({ type: "note", text: "hi" })).toThrow();
    expect(() => DetailBlock.parse({ type: "table", rows: [] })).toThrow();
  });

  it("非法 format 枚举值被拒", () => {
    expect(() =>
      DetailBlock.parse({ type: "stat", label: "x", value: 1, format: "eth" }),
    ).toThrow();
  });

  it("缺必填字段被拒:stat 缺 value / format,addressList 项缺 address", () => {
    expect(() => DetailBlock.parse({ type: "stat", label: "x", format: "usd" })).toThrow();
    expect(() => DetailBlock.parse({ type: "stat", label: "x", value: 1 })).toThrow();
    expect(() => DetailBlock.parse({ type: "addressList", items: [{ path: "m/0" }] })).toThrow();
  });

  it("缺可选字段容错:optional 缺省仍 parse", () => {
    const kv = DetailBlock.parse({ type: "keyValue", items: [] });
    expect(kv).toMatchObject({ type: "keyValue", items: [] });
    const al = DetailBlock.parse({ type: "addressList", items: [{ address: "bc1q" }] });
    expect(al).toMatchObject({ type: "addressList" });
  });
});

describe("DetailBlock —— 类型完备", () => {
  it("DetailBlockType 恰为词汇表 v1 三块", () => {
    expectTypeOf<DetailBlockType>().toEqualTypeOf<"stat" | "keyValue" | "addressList">();
  });

  it("DetailFormat 恰为 5 个通用格式(无链专属单位)", () => {
    expectTypeOf<z.infer<typeof DetailFormat>>().toEqualTypeOf<
      "usd" | "amount" | "percent" | "date" | "address"
    >();
  });

  it("窄化后块字段精确(消灭 as cast)", () => {
    const b = DetailBlock.parse({ type: "stat", label: "x", value: 1, format: "amount" });
    if (b.type === "stat") {
      expectTypeOf(b).toEqualTypeOf<z.infer<typeof StatBlock>>();
      expect(b.value).toBe(1);
    }
  });

  it("子集 schema 可单独校验(provider 拼块基础)", () => {
    const r = AddressListBlock.safeParse({ type: "addressList", items: [{ address: "a" }] });
    expect(r.success).toBe(true);
  });
});
