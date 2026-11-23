import { beforeEach, describe, expect, it, vi } from "vitest";
import { __toastStore, toast } from "../src/components/motion/toast-store";

beforeEach(() => __toastStore.reset());

describe("toast store", () => {
  it("loading creates a persistent toast and returns its id", () => {
    const id = toast.loading("Syncing");
    const snap = __toastStore.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id, title: "Syncing", status: "loading", duration: 0 });
  });

  it("calling again with an existing {id} updates in place without adding", () => {
    const id = toast.loading("Syncing");
    const returned = toast.success("Synced", { id });
    const snap = __toastStore.snapshot();
    expect(returned).toBe(id);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ id, title: "Synced", status: "success" });
    expect(snap[0].duration).toBeGreaterThan(0);
  });

  it("without {id}, or with an unknown id, creates a new toast", () => {
    toast.loading("a");
    toast.success("b");
    toast.error("c", { id: "does-not-exist" });
    expect(__toastStore.snapshot().map((t) => t.status)).toEqual(["loading", "success", "error"]);
  });

  it("passes action / description through", () => {
    const onClick = () => {};
    const id = toast.message("Update available", {
      id: "sw-update",
      description: "Click update to load the latest version",
      action: { label: "Update", onClick },
    });
    const snap = __toastStore.snapshot();
    expect(id).toBe("sw-update");
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      title: "Update available",
      description: "Click update to load the latest version",
    });
    expect(snap[0].action?.label).toBe("Update");
    expect(snap[0].action?.onClick).toBe(onClick);
  });

  it("passes duration through (0 = persistent, overrides the terminal default)", () => {
    toast.message("Persistent", { id: "keep", duration: 0 });
    expect(__toastStore.snapshot()[0].duration).toBe(0);
  });

  // Browsers clamp an Infinity setTimeout to 0, which dismissed the toast instantly; fake timers
  // can't reproduce that clamp, so spy on setTimeout directly.
  it("does not schedule a timer for a non-finite duration (Infinity)", () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    toast.message("Update available", { id: "sw-update", duration: Number.POSITIVE_INFINITY });
    const scheduledNonFinite = spy.mock.calls.some(([, delay]) => !Number.isFinite(delay));
    spy.mockRestore();
    expect(scheduledNonFinite).toBe(false);
    expect(__toastStore.snapshot().some((t) => t.id === "sw-update")).toBe(true);
  });

  it("leaves action/description undefined when omitted", () => {
    toast.success("ok");
    const t = __toastStore.snapshot()[0];
    expect(t.action).toBeUndefined();
    expect(t.description).toBeUndefined();
  });

  it("dismiss(id) removes that toast", () => {
    const id = toast.loading("a");
    toast.success("b");
    toast.dismiss(id);
    const snap = __toastStore.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap.some((t) => t.id === id)).toBe(false);
  });
});
