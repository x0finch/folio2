import { describe, expect, it, vi } from "vitest";
import { warmTokensForUsers } from "../../src/lib/server/internal/sync-deps";

// #375 第 2 步 · 纵深防御:sweep 收尾逐用户预热,一个用户失败不该拖垮其余、也不该把整次 cron
// 拖成异常收尾。`warmTokensForUsers` 收一个可注入的 `warmOne` 正是为了在这里让指定用户失败 ——
// 生产路径用默认的 `warmTokensForUser`(碰真 db/oracle),这一层的逻辑只有「兜住 + 计数」。
//
// 放在 tests/server/(workers pool):import sync-deps 会连带 `cloudflare:workers`,只有这个 pool 解析得了。
// 但本用例不碰 D1 —— 全靠注入的假 `warmOne`。
describe("warmTokensForUsers", () => {
  it("某个用户失败:其余用户照样预热,整体不抛,计数分明", async () => {
    const seen: string[] = [];
    const warmOne = vi.fn(async (userId: string) => {
      seen.push(userId);
      if (userId === "b") throw new Error("coingecko rate limited: /api/v3/simple/price");
    });

    const report = await warmTokensForUsers(["a", "b", "c"], warmOne);

    // b 抛了,但 c 仍被调用 —— 循环没有被一个用户的失败中断。
    expect(seen).toEqual(["a", "b", "c"]);
    expect(report).toEqual({ warmed: 2, failed: 1 });
  });

  it("全部成功", async () => {
    const warmOne = vi.fn(async () => {});
    const report = await warmTokensForUsers(["a", "b"], warmOne);
    expect(report).toEqual({ warmed: 2, failed: 0 });
  });

  it("空名单:零调用、零计数", async () => {
    const warmOne = vi.fn(async () => {});
    const report = await warmTokensForUsers([], warmOne);
    expect(warmOne).not.toHaveBeenCalled();
    expect(report).toEqual({ warmed: 0, failed: 0 });
  });
});
