import { describe, expect, it } from "vitest";
import { buildBtcDetail } from "../src";
import { buildDetailFixtures as fx } from "./fixtures/build-detail";

// buildBtcDetail 的 golden 单测(fixture 三件一体:input pendingSats/dist/receive → 期望完整 markdown)。
// 断言精确字符串(肉眼可核)。分布结构:*Receive* / *Change* 两子列表(仅该子列表有地址才出子标题)。

describe("buildBtcDetail (golden: fixture in → markdown out)", () => {
  it("① 未确认 + 收款指引 + receive/change 两子列表分布", () => {
    const c = fx.full;
    expect(buildBtcDetail(c.input.pendingSats, c.input.dist, c.input.receive)).toBe(c.expected);
  });

  it("② 仅地址模式:只有未确认(无分布/收款指引)", () => {
    const c = fx.addressOnly;
    expect(buildBtcDetail(c.input.pendingSats, c.input.dist, c.input.receive)).toBe(c.expected);
  });

  it("③ 无 change 子列表 → 只出 *Receive* 子列表", () => {
    const c = fx.receiveOnly;
    const out = buildBtcDetail(c.input.pendingSats, c.input.dist, c.input.receive);
    expect(out).toBe(c.expected);
    expect(out).not.toContain("*Change*");
  });

  it("全空 → undefined(不塞 detail)", () => {
    expect(buildBtcDetail(0, [])).toBeUndefined();
  });
});
