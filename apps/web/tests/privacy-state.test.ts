import { describe, expect, it } from "vitest";
import {
  isHidden,
  type PrivacyState,
  parseCachedHideBalances,
  privacyReducer,
  resolveInitialEnabled,
  serializeHideBalances,
} from "@/lib/privacy/state";

// 余额隐私纯状态机(ADR 0052)。测的是外部行为:enabled/revealed 组合下遮不遮、各事件怎么迁移、
// fail-closed、缓存命中/未命中/校准 —— 不碰 DOM,故是 node 侧 .test.ts。

const S = (enabled: boolean, revealed: boolean): PrivacyState => ({ enabled, revealed });

describe("isHidden", () => {
  it("开着隐私、没临时显示 → 遮", () => {
    expect(isHidden(S(true, false))).toBe(true);
  });
  it("开着隐私、正临时显示 → 不遮", () => {
    expect(isHidden(S(true, true))).toBe(false);
  });
  it("没开隐私 → 永不遮", () => {
    expect(isHidden(S(false, false))).toBe(false);
    expect(isHidden(S(false, true))).toBe(false);
  });
});

describe("resolveInitialEnabled (fail-closed + 缓存)", () => {
  it("没缓存 → 先当开(fail-closed,先遮)", () => {
    expect(resolveInitialEnabled(null)).toBe(true);
  });
  it("缓存是 ON → 开(直接遮,不闪)", () => {
    expect(resolveInitialEnabled(true)).toBe(true);
  });
  it("缓存是 OFF → 关(不遮、不闪)", () => {
    expect(resolveInitialEnabled(false)).toBe(false);
  });
});

describe("privacyReducer: reveal", () => {
  it("开着隐私时 reveal → 临时显示", () => {
    expect(privacyReducer(S(true, false), { type: "reveal" })).toEqual(S(true, true));
  });
  it("没开隐私时 reveal → no-op,且引用不变", () => {
    const s = S(false, false);
    expect(privacyReducer(s, { type: "reveal" })).toBe(s);
  });
  it("已在显示中再 reveal → 引用不变", () => {
    const s = S(true, true);
    expect(privacyReducer(s, { type: "reveal" })).toBe(s);
  });
});

describe("privacyReducer: leave 收回临时显示", () => {
  it("正显示中遇到任何离开 → 重新遮上", () => {
    expect(privacyReducer(S(true, true), { type: "leave" })).toEqual(S(true, false));
  });
  it("本就没在显示 → 引用不变", () => {
    const s = S(true, false);
    expect(privacyReducer(s, { type: "leave" })).toBe(s);
  });
});

describe("privacyReducer: sync 校准", () => {
  it("服务器/缓存说开 → enabled=true", () => {
    expect(privacyReducer(S(false, false), { type: "sync", hideBalances: true })).toEqual(
      S(true, false),
    );
  });
  it("服务器说关 → enabled=false,并清掉悬着的 revealed", () => {
    expect(privacyReducer(S(true, true), { type: "sync", hideBalances: false })).toEqual(
      S(false, false),
    );
  });
  it("值没变(仍开、仍显示)→ 引用不变,不打断当前的临时显示", () => {
    const s = S(true, true);
    expect(privacyReducer(s, { type: "sync", hideBalances: true })).toBe(s);
  });
  it("fail-closed 落地一例:无缓存先遮,服务器随后说关 → 化开", () => {
    // 冷启动无缓存 → resolveInitialEnabled(null)=true;第一帧 isHidden 为真(遮)。
    let s = S(resolveInitialEnabled(null), false);
    expect(isHidden(s)).toBe(true);
    // 服务器读回来说其实没开 → 校准后不再遮。
    s = privacyReducer(s, { type: "sync", hideBalances: false });
    expect(isHidden(s)).toBe(false);
  });
});

describe("缓存序列化", () => {
  it("往返", () => {
    expect(parseCachedHideBalances(serializeHideBalances(true))).toBe(true);
    expect(parseCachedHideBalances(serializeHideBalances(false))).toBe(false);
  });
  it("缺失 / 脏值 → null(当没缓存 → fail-closed)", () => {
    expect(parseCachedHideBalances(null)).toBeNull();
    expect(parseCachedHideBalances("")).toBeNull();
    expect(parseCachedHideBalances("true")).toBeNull();
  });
});
