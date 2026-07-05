import { beforeEach, describe, expect, it } from "vitest";
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

  it("dismiss(id) 移除该条", () => {
    const id = toast.loading("a");
    toast.success("b");
    toast.dismiss(id);
    const snap = __toastStore.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap.some((t) => t.id === id)).toBe(false);
  });
});
