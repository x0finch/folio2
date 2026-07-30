import { describe, expect, it, vi } from "vitest";
import { swr } from "../src";

// SWR 编排是全层唯一知道「读本地 → 判 stale → 回源 → 写回」的地方(ADR 0023)。
// 它的语义在这里测一次,价 / 历史价 / warm 三处就不用各测一遍。
describe("swr", () => {
  const hit = (value: string, stale: boolean) => async () => ({ value, stale });

  it("新鲜 → 直接回,不碰上游、不写回", async () => {
    const fetch = vi.fn();
    const write = vi.fn();
    expect(await swr({ read: hit("fresh", false), fetch, write })).toBe("fresh");
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("stale → 回源 → 写回 → 回新值", async () => {
    const write = vi.fn(async () => {});
    const got = await swr({ read: hit("old", true), fetch: async () => "new", write });
    expect(got).toBe("new");
    expect(write).toHaveBeenCalledWith("new");
  });

  it("miss → 回源 → 写回", async () => {
    const write = vi.fn(async () => {});
    expect(await swr({ read: async () => undefined, fetch: async () => "new", write })).toBe("new");
    expect(write).toHaveBeenCalledOnce();
  });

  it("上游没有 → 把旧值原样给出去,不写回(过期不删)", async () => {
    const write = vi.fn();
    expect(await swr({ read: hit("old", true), fetch: async () => undefined, write })).toBe("old");
    expect(write).not.toHaveBeenCalled();
  });

  it("上游抛错也算「没有」→ 降级到本地,不向上抛", async () => {
    const boom = async () => {
      throw new Error("429");
    };
    expect(await swr({ read: hit("old", true), fetch: boom, write: async () => {} })).toBe("old");
    // 连旧值都没有 → undefined,调用方降级
    expect(
      await swr({ read: async () => undefined, fetch: boom, write: async () => {} }),
    ).toBeUndefined();
  });
});
