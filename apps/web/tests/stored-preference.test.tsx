import { act, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storedPreference } from "@/lib/hooks/stored-preference";

// 每浏览器一份的展示偏好(界面语言 / 展示币种都靠它):读写都过 parse,写完本标签立刻跟着变,
// 别的标签改了也跟着变;服务端 / 补水那一帧用壳的默认值;storage 被禁时不炸、本次会话照样生效。

type Mode = "light" | "dark";
const KEY = "test_pref_mode";
const parse = (raw: string | null): Mode => (raw === "dark" ? "dark" : "light");

function Show({ useValue }: { useValue: () => Mode }) {
  return <span data-testid="v">{useValue()}</span>;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("storedPreference", () => {
  it("read:没存过 → parse(null);存了认不得的值 → 也落回默认", () => {
    const pref = storedPreference(KEY, parse, "light");
    expect(pref.read()).toBe("light");
    localStorage.setItem(KEY, "purple");
    expect(pref.read()).toBe("light");
    localStorage.setItem(KEY, "dark");
    expect(pref.read()).toBe("dark");
  });

  it("write 先过 parse:存进去的一定是认得的值", () => {
    const pref = storedPreference(KEY, parse, "light");
    pref.write("dark");
    expect(localStorage.getItem(KEY)).toBe("dark");
    pref.write("garbage");
    expect(localStorage.getItem(KEY)).toBe("light");
  });

  it("本标签 write 后,订阅中的组件立刻重渲成新值", () => {
    const pref = storedPreference(KEY, parse, "light");
    render(<Show useValue={pref.useValue} />);
    expect(screen.getByTestId("v").textContent).toBe("light");
    act(() => pref.write("dark"));
    expect(screen.getByTestId("v").textContent).toBe("dark");
  });

  it("别的标签改了同一个键 → 跟着变;改别的键不理", () => {
    const pref = storedPreference(KEY, parse, "light");
    render(<Show useValue={pref.useValue} />);
    act(() => {
      localStorage.setItem(KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    });
    expect(screen.getByTestId("v").textContent).toBe("dark");
    act(() => {
      localStorage.setItem(KEY, "light");
      window.dispatchEvent(new StorageEvent("storage", { key: "some_other_key" }));
    });
    expect(screen.getByTestId("v").textContent).toBe("dark");
  });

  it("别的标签清空整个存储(key=null)→ 回到默认", () => {
    const pref = storedPreference(KEY, parse, "light");
    localStorage.setItem(KEY, "dark");
    render(<Show useValue={pref.useValue} />);
    expect(screen.getByTestId("v").textContent).toBe("dark");
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(screen.getByTestId("v").textContent).toBe("light");
  });

  it("服务端渲染用 serverValue,不读 localStorage(补水首帧与静态壳一致)", () => {
    localStorage.setItem(KEY, "dark");
    const pref = storedPreference(KEY, parse, "light");
    expect(renderToString(<Show useValue={pref.useValue} />)).toContain(">light<");
  });

  it("storage 被禁(读写都抛)时:读回默认、写不抛,页面照常渲染", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    const pref = storedPreference(KEY, parse, "light");
    expect(pref.read()).toBe("light");
    render(<Show useValue={pref.useValue} />);
    expect(() => act(() => pref.write("dark"))).not.toThrow();
    expect(screen.getByTestId("v").textContent).toBe("light");
  });
});
