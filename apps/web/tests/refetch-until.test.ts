import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refetchUntil } from "@/lib/queries/constants";

const runToEnd = async <T>(p: Promise<T>) => {
  await vi.runAllTimersAsync();
  return p;
};

describe("refetchUntil", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("第一次就满足条件 → 只拉一次", async () => {
    const refetch = vi.fn().mockResolvedValue("ok");
    const out = await runToEnd(refetchUntil(refetch, (p) => p === "ok"));
    expect(out).toBe("ok");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("退避等到条件满足", async () => {
    const refetch = vi.fn().mockResolvedValueOnce("a").mockResolvedValueOnce("b");
    const out = await runToEnd(refetchUntil(refetch, (p: string) => p.includes("b")));
    expect(out).toBe("b");
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("等不到也返回手上那份", async () => {
    const refetch = vi.fn().mockResolvedValue("nope");
    const out = await runToEnd(refetchUntil(refetch, (p: string) => p.includes("b")));
    expect(out).toBe("nope");
    expect(refetch).toHaveBeenCalledTimes(5);
  });
});
