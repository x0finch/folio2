import { act, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storedPreference } from "@/lib/hooks/stored-preference";

type Mode = "light" | "dark";
const KEY = "test_pref_mode";
const parse = (raw: string | null): Mode => (raw === "dark" ? "dark" : "light");

function Show({ useValue }: { useValue: () => Mode }) {
  return <span data-testid="v">{useValue()}</span>;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("storedPreference", () => {
  it("read: never stored: parse(null); stored an unrecognized value: also falls back to the default", () => {
    const pref = storedPreference(KEY, parse, "light");
    expect(pref.read()).toBe("light");
    localStorage.setItem(KEY, "purple");
    expect(pref.read()).toBe("light");
    localStorage.setItem(KEY, "dark");
    expect(pref.read()).toBe("dark");
  });

  it("write goes through parse first: whatever is stored is always a recognized value", () => {
    const pref = storedPreference(KEY, parse, "light");
    pref.write("dark");
    expect(localStorage.getItem(KEY)).toBe("dark");
    pref.write("garbage");
    expect(localStorage.getItem(KEY)).toBe("light");
  });

  it("after a write in this tab, subscribed components re-render with the new value at once", () => {
    const pref = storedPreference(KEY, parse, "light");
    render(<Show useValue={pref.useValue} />);
    expect(screen.getByTestId("v").textContent).toBe("light");
    act(() => pref.write("dark"));
    expect(screen.getByTestId("v").textContent).toBe("dark");
  });

  it("another tab changes the same key: follows; other keys are ignored", () => {
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

  it("another tab clears the whole storage (key=null): back to the default", () => {
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

  it("server render uses serverValue and does not read localStorage (hydration first frame matches the static shell)", () => {
    localStorage.setItem(KEY, "dark");
    const pref = storedPreference(KEY, parse, "light");
    expect(renderToString(<Show useValue={pref.useValue} />)).toContain(">light<");
  });

  it("storage disabled (reads and writes throw): reads default, write does not throw, the page renders as usual", () => {
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
