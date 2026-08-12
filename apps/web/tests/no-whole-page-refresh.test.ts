import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #416 的**硬验收,机械可查**:整页刷新这条路要归零。
//
// 为什么值得写成一条测试而不是「迁完看一眼」:定向刷新漏改**不报错**,只表现为「改了东西画面不变」。
// 全仓二十几处调用点,人眼过一遍的可信度不高,而且下次谁图省事又写回一句整页刷新,
// 一样悄无声息 —— 那一句在今天这套形状下**刷不动任何已迁的域**(`ensureQueryData` 只要缓存里有
// 数据就原样返回,不看 stale),只会给人「我刷过了」的错觉。
//
// **禁两样,不是一样**(review 补):
//   · `.invalidate(` —— 直接调用。
//   · `useRouter(` —— 拿到 router 实例这一步。原先只禁前者,`const { invalidate } = useRouter()`
//     这种写法整条溜过去。本仓需要的路由读取是 `useRouterState`(不匹配),所以直接禁到源头最省事。
//
// **注释先剥掉再匹配**:否则连「别再写 router.invalidate 了」这样一句说明都会把测试弄红,
// 逼着后来人绕开词汇去描述这件事 —— 守卫不该反过来管文档怎么写。
const SRC = join(import.meta.dirname, "../src");

const BANNED = [".invalidate(", "useRouter("] as const;

// **一处按文件放行 `useRouter(`**:滚动记忆(片1 / ADR 0042)要订阅 `onRendered`,而且必须排在
// router 自己那条订阅之后才不会被它的归零盖掉 —— `useRouterState` 给的是状态,给不了订阅口,
// 所以这一处非拿实例不可。放行只放 `useRouter(` 这一个词:这个文件写 `.invalidate(` 照旧判红,
// 别的文件写 `useRouter(` 也照旧判红,守卫原本要抓的那条路(从 useRouter 里摸出 invalidate)没松。
const ROUTER_INSTANCE_ALLOWED = new Set(["lib/hooks/use-app-scroll-memory.ts"]);

function violations(relativePath: string, code: string): string[] {
  return BANNED.filter((needle) => {
    if (!code.includes(needle)) return false;
    return !(needle === "useRouter(" && ROUTER_INSTANCE_ALLOWED.has(relativePath));
  });
}

// 剥注释。`//` 只在**不是紧跟在冒号后面**时才当行注释起点 —— 否则 `"https://…"` 里的那两个斜杠
// 会把整行后半截当成注释吃掉,真有违规反而被藏起来。
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

describe("整页刷新已退场", () => {
  it("apps/web/src 里既没有 router.invalidate,也没人再去拿 router 实例", () => {
    const offenders = [...walk(SRC)].flatMap((f) => {
      const rel = f.slice(SRC.length + 1);
      const hits = violations(rel, stripComments(readFileSync(f, "utf8")));
      return hits.length > 0 ? [`${rel} → ${hits.join(", ")}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  // 放行是**按文件 + 按词**的,别退化成「这个文件随便写」。
  it("放行的那一处仍然不许写 invalidate,别的文件也仍然不许拿 router 实例", () => {
    const [allowed] = ROUTER_INSTANCE_ALLOWED;
    expect(violations(allowed, "const r = useRouter();")).toEqual([]);
    expect(violations(allowed, "const r = useRouter(); r.invalidate();")).toEqual([".invalidate("]);
    expect(violations("components/whatever.tsx", "const r = useRouter();")).toEqual(["useRouter("]);
  });

  // 守卫本身的守卫:上面那条只有在**真能抓到**违规时才有意义。剥注释的正则写错一次
  // (比如把整份源码都当成注释剥掉),测试会变成永远绿的摆设,而没人看得出来。
  it("剥注释之后仍抓得到代码里的违规,且不误伤注释与 URL", () => {
    expect(stripComments("const r = useRouter();").includes("useRouter(")).toBe(true);
    expect(stripComments("// 别再写 router.invalidate() 了").includes(".invalidate(")).toBe(false);
    expect(
      stripComments('const u = "https://x.dev"; r.invalidate();').includes(".invalidate("),
    ).toBe(true);
  });
});
