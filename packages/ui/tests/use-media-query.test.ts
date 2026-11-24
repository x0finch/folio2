// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "../src/lib/hooks/use-media-query";

// jsdom has no matchMedia; a controllable fake is installed.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = () => void;
const lists = new Map<string, { matches: boolean; listeners: Set<Listener> }>();

function fakeMatchMedia(query: string) {
  let entry = lists.get(query);
  if (!entry) {
    entry = { matches: false, listeners: new Set() };
    lists.set(query, entry);
  }
  const e = entry;
  return {
    get matches() {
      return e.matches;
    },
    addEventListener: (_: string, l: Listener) => e.listeners.add(l),
    removeEventListener: (_: string, l: Listener) => e.listeners.delete(l),
  };
}

let root: Root;
let seen: boolean[];

function Probe({ query }: { query: string }) {
  seen.push(useMediaQuery(query));
  return null;
}

function mount(query: string) {
  act(() => root.render(createElement(Probe, { query })));
}

beforeEach(() => {
  lists.clear();
  seen = [];
  vi.stubGlobal("matchMedia", fakeMatchMedia);
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useMediaQuery", () => {
  it("is false on first render and reflects the real match after mount", () => {
    fakeMatchMedia("(min-width: 768px)");
    lists.get("(min-width: 768px)")!.matches = true;
    mount("(min-width: 768px)");
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
  });

  it("stays false without matchMedia and does not throw", () => {
    vi.stubGlobal("matchMedia", undefined);
    mount("(d)");
    expect(seen.every((v) => v === false)).toBe(true);
  });
});
