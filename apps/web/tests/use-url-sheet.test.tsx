import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUrlSheet } from "../src/lib/hooks/use-url-sheet";

// 抽屉进 URL(ADR 0043 那套的延伸)。开合一旦只由 `?asset=` / `?account=` 表达,「开着没开」与
// 「显示哪一个」就成了同一个来源 —— 关闭那一帧内容会先空掉,退场动画播的是个空壳。这个 hook 就是
// 那道缓冲,所以它的正经逻辑是「值没了以后还给不给内容」。

describe("useUrlSheet", () => {
  it("没选中 → 不开,也没内容", () => {
    const { result } = renderHook(() => useUrlSheet<string>(null));
    expect(result.current).toEqual({ open: false, shown: null });
  });

  it("有选中 → 开,内容就是它", () => {
    const { result } = renderHook(() => useUrlSheet<string>("btc"));
    expect(result.current).toEqual({ open: true, shown: "btc" });
  });

  it("**选中被清掉 → 立刻关,但内容留着**(退场动画还要用它)", () => {
    const { result, rerender } = renderHook(({ v }) => useUrlSheet(v), {
      initialProps: { v: "btc" as string | null },
    });
    rerender({ v: null });
    expect(result.current).toEqual({ open: false, shown: "btc" });
  });

  it("换一个选中项 → 一直开着,内容跟着换(不经过一次关闭)", () => {
    const { result, rerender } = renderHook(({ v }) => useUrlSheet(v), {
      initialProps: { v: "btc" as string | null },
    });
    rerender({ v: "eth" });
    expect(result.current).toEqual({ open: true, shown: "eth" });
    rerender({ v: null });
    expect(result.current.shown).toBe("eth");
  });

  it("对象也认(抽屉拿的是整行,不是 id)", () => {
    const row = { id: "acc_1", label: "Ledger" };
    const { result, rerender } = renderHook(({ v }) => useUrlSheet(v), {
      initialProps: { v: row as typeof row | null },
    });
    rerender({ v: null });
    expect(result.current.shown).toBe(row);
  });

  it("空串是**有值**:判据是 `!= null` 而不是真假值", () => {
    // 写成 `if (value)` 的话空串会被当成没有 —— 这一层不该对「什么算合法的值」有意见,
    // 认不认得出那个 key 是调用方的事(它拿 `find` 的结果进来)。
    const { result } = renderHook(() => useUrlSheet(""));
    expect(result.current).toEqual({ open: true, shown: "" });
  });

  it("一开始就没有 → 内容是 null(带着乱码 `?asset=` 直接进来,抽屉不该有内容)", () => {
    const { result } = renderHook(() => useUrlSheet<string>(null));
    expect(result.current.shown).toBeNull();
  });
});
