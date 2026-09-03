import { beforeEach, describe, expect, it, vi } from "vitest";
import { __toastStore, toast } from "../src/components/motion/toast-store";

beforeEach(() => __toastStore.reset());

describe("toast store", () => {
  it("loading 创建一条持久 toast 并返回 id", () => {
    const id = toast.loading("同步中");
    const snap = __toastStore.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id, title: "同步中", status: "loading", duration: 0 });
  });

  it("带既有 {id} 再调 → 同一条原地更新(loading→success),不新增", () => {
    const id = toast.loading("同步中");
    const returned = toast.success("已同步", { id });
    const snap = __toastStore.snapshot();
    expect(returned).toBe(id);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id, title: "已同步", status: "success" });
    expect(snap[0].duration).toBeGreaterThan(0); // 终态自动消失
  });

  it("error 同样支持 {id} 原地更新", () => {
    const id = toast.loading("同步中");
    toast.error("失败了", { id });
    const snap = __toastStore.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id, title: "失败了", status: "error" });
  });

  it("无 {id} 或 id 不存在 → 新建独立 toast", () => {
    toast.loading("a");
    toast.success("b");
    toast.error("c", { id: "does-not-exist" });
    expect(__toastStore.snapshot()).toHaveLength(3);
  });

  it("透传 action / description(带按钮的 toast)", () => {
    const onClick = () => {};
    const id = toast.message("有新版本", {
      id: "sw-update",
      description: "点更新加载最新版",
      action: { label: "更新", onClick },
    });
    const snap = __toastStore.snapshot();
    expect(id).toBe("sw-update");
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ title: "有新版本", description: "点更新加载最新版" });
    expect(snap[0].action?.label).toBe("更新");
    expect(snap[0].action?.onClick).toBe(onClick);
  });

  it("透传 duration(0 = 常驻,覆盖终态默认时长)", () => {
    toast.message("常驻", { id: "keep", duration: 0 });
    expect(__toastStore.snapshot()[0].duration).toBe(0);
  });

  // 回归:duration:Infinity 曾直接进 setTimeout → 真实浏览器把 Infinity 当 0 → toast 秒删
  //(「点更新没 toast」)。这里**监视 setTimeout**断言不为非有限时长排定时器 —— 假定时器复现不了那个
  // 平台钳制,所以不能靠「推进时间看还在不在」,得直接盯排定时器这一步。
  it("duration 非有限值(Infinity)不排定时器(否则真实浏览器里被当 0 秒删)", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    toast.message("有新版本", { id: "sw-update", duration: Number.POSITIVE_INFINITY });
    const scheduledNonFinite = spy.mock.calls.some(([, delay]) => !Number.isFinite(delay));
    spy.mockRestore();
    expect(scheduledNonFinite).toBe(false);
    expect(__toastStore.snapshot().some((t) => t.id === "sw-update")).toBe(true);
  });

  it("不传 action/description 时字段为 undefined(现有调用点零改动)", () => {
    toast.success("ok");
    const t = __toastStore.snapshot()[0];
    expect(t.action).toBeUndefined();
    expect(t.description).toBeUndefined();
  });

  it("dismiss(id) 移除该条", () => {
    const id = toast.loading("a");
    toast.success("b");
    toast.dismiss(id);
    const snap = __toastStore.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap.some((t) => t.id === id)).toBe(false);
  });
});
