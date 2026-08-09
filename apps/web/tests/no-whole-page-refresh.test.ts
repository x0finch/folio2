import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #416 的**硬验收,机械可查**:整页刷新这条路要归零。
//
// 为什么值得写成一条测试而不是「迁完看一眼」:定向刷新漏改**不报错**,只表现为「改了东西画面不变」。
// 全仓二十几处调用点,人眼过一遍的可信度不高,而且下次谁图省事又写回一句 `router.invalidate()`,
// 一样悄无声息 —— 那一句在今天这套形状下**刷不动任何已迁的域**(`ensureQueryData` 只要缓存里有
// 数据就原样返回,不看 stale),只会给人「我刷过了」的错觉。
//
// 只禁 `router.invalidate`。`useRouterState` 之类的路由读取照常用。
const SRC = join(import.meta.dirname, "../src");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

describe("整页刷新已退场", () => {
  it("apps/web/src 里没有 router.invalidate", () => {
    const offenders = [...walk(SRC)].filter((f) =>
      readFileSync(f, "utf8").includes(".invalidate("),
    );
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
