import { describe, expect, it } from "vitest";
import { OccurredAt } from "@/lib/server/manual-activities/occurred-at";

// 手记活动的时间戳能落在哪个区间(#527 裁定 6)。纯 schema,所以跑在 logic 项目里。
describe("OccurredAt", () => {
  const ok = (ms: number) => OccurredAt.safeParse(ms).success;

  it("过去的时间 → 收(补记往帐是正常操作)", () => {
    expect(ok(Date.now() - 365 * 24 * 3600_000)).toBe(true);
    expect(ok(0)).toBe(true);
  });

  it("刚刚 → 收", () => {
    expect(ok(Date.now())).toBe(true);
  });

  it("快一点点的客户端时钟(未来一分钟)→ 仍然收", () => {
    // 严格挡会把「刚刚记的一笔」误拒,而那种拒绝没有可操作的解释可给用户。
    expect(ok(Date.now() + 60_000)).toBe(true);
  });

  it("明天 / 明年 → 拒", () => {
    expect(ok(Date.now() + 24 * 3600_000)).toBe(false);
    expect(ok(Date.now() + 365 * 24 * 3600_000)).toBe(false);
  });

  it("小数 → 拒(时间戳是整毫秒)", () => {
    expect(ok(1.5)).toBe(false);
  });
});
