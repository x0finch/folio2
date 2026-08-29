import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// **钉 / 取消 / 改指向,写完都要等 tab 条真的变了再收工。**
//
// tab 条是预计算出来的(ADR 0049):写路径只抬失效水位线,重算跑在 `waitUntil` 上。所以写完
// 紧跟着的那次刷新拿回的往往还是**改动之前**那份条子 —— 新钉的 Tab 还不在里面,`selectTab`
// 选中一个条子上没有的 id,药丸不动,用户看到的是「点了没反应」;改指向则挂着老名字、
// 渲染老目标的内容。
//
// **为什么读源码**:这三处是 mutation 回调里的接线,要跑行为得把 router + queryClient + 真
// server fn 一起立起来,而那套东西这个仓里没有;而「有没有等」在源码里一眼看得见。
// 同 `home-loader.test.ts` 的做法。

const SRC = join(import.meta.dirname, "../src/routes/_authed/-home/tab/pin.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("pin 写完等条子", () => {
  const src = () => stripComments(readFileSync(SRC, "utf8"));

  it("三处写各等一次", () => {
    // create / delete / updateTarget 三个 mutation,每个的 onSuccess 里都得有那一等。
    expect(src().match(/await awaitStrip\(/g) ?? []).toHaveLength(3);
  });

  it("新 Tab 是**等到它出现之后**才选中的,不是刷新一下就选", () => {
    const s = src();
    const wait = s.indexOf("await awaitStrip", s.indexOf("createTabPin"));
    const select = s.indexOf("selectTab(pin.id)", s.indexOf("createTabPin"));
    expect(wait).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(wait);
  });
});
