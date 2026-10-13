// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "../src/lib/hooks/use-media-query";

// 按视口 / 指针能力切布局的 hook:首帧 false、挂载后反映真实匹配;
// 没有 matchMedia 的环境保持 false 不抛。jsdom 没有 matchMedia,这里补一个可控的假实现。

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
  it("首帧是 false(与服务端一致),挂载后换成真实匹配", () => {
    fakeMatchMedia("(min-width: 768px)");
    lists.get("(min-width: 768px)")!.matches = true;
    mount("(min-width: 768px)");
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
  });

  it("没有 matchMedia 时恒为 false,不抛", () => {
    vi.stubGlobal("matchMedia", undefined);
    mount("(d)");
    expect(seen.every((v) => v === false)).toBe(true);
  });
});
