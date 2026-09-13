import { readFileSync } from "node:fs";
import { join } from "node:path";

// 四份 loader 源码测试(home / accounts / insights / settings)共用的取源工具。这些测试钉的是
// 「哪一页取什么、什么都不 await」—— 靶子是源码文本,不是运行结果,所以工具也是文本级的。

const ROOT = join(import.meta.dirname, "../../src");
const PREFETCH = "lib/queries/prefetch-pages.ts";

export function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// 某个函数从 `function name` 到下一个顶层函数(或文件尾)的那一段。
function functionSlice(all: string, name: string): string | null {
  const m = new RegExp(`(?:export )?function ${name}\\(`).exec(all);
  if (!m) return null;
  const rest = all.slice(m.index + m[0].length);
  const next = rest.search(/\n(?:export )?function /);
  return next < 0 ? all.slice(m.index) : all.slice(m.index, m.index + m[0].length + next);
}

// 只取某一个 prefetch 函数的身体:四页的预取同住一个文件,不切出来的话「总览不取 X」会被隔壁那页
// 取 X 的那行冒充成绿的。找不到就抛 —— 切空了的话下面每条 `not.toContain` 都是空断言。
//
// 几页共用的原料收在同文件的**非导出**小函数里(总览与洞察那八条同款查询);这里把身体里调到的
// 那些一并接上,断言看到的仍是「这一页实际取了什么」,而不用管它在源码里分了几层。
export function prefetchBody(name: string): string {
  const all = stripComments(readSrc(PREFETCH));
  const own = functionSlice(all, name);
  if (!own) throw new Error(`prefetch-pages.ts 里没有 ${name}`);
  const helpers = [...own.matchAll(/\b([a-z]\w*)\(queryClient/g)]
    .map((m) => m[1])
    .filter((id, i, arr) => id !== name && arr.indexOf(id) === i)
    .map((id) => functionSlice(all, id))
    .filter((slice): slice is string => slice != null && !slice.startsWith("export "));
  return [own, ...helpers].join("\n");
}
