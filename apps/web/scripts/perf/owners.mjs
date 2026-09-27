// 采样帧 → 「这毫秒是谁的」。
//
// 不按 chunk 文件名猜(`Effect-DrAECYHU.js` 的散列每次构建都变,`format-number-*.js` 这种名字
// 只是 rolldown 挑的第一个模块,里面装的是一堆别的):服务端构建产物没压缩,rolldown 给每个
// 源模块留了 `//#region <源路径>` … `//#endregion` 注释。按帧的行号落进哪个 region,就知道它
// 来自哪个源文件、哪个包 —— 构建怎么切 chunk 都不影响归属。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DIST_SERVER_DIR, WEB_ROOT } from "./constants.mjs";

/** V8 的伪帧:不是 JS 在跑。`(program)` 是 V8 说不清归谁的原生时间,最初那轮测量的口径也不计入。 */
export const NON_CPU_FRAMES = new Set(["(idle)", "(program)", "(root)"]);

// 包名 → 归属组。只列真正值得单独看的;其余第三方包按包名自成一组(见 classifyModule)。
const PACKAGE_GROUPS = [
  [/^effect$|^@effect\//, "Effect"],
  [/^@tanstack\/(react-start|start-)/, "TanStack Start"],
  [/^h3(-|$)|^cookie-es$|^rou3$|^srvx$/, "TanStack Start"],
  [/^@tanstack\/(react-router|router-core|history)/, "TanStack Router"],
  [/^seroval/, "seroval"],
  [
    /^better-auth$|^@better-auth\/|^better-call$|^@better-fetch\/|^kysely$|^jose$|^@noble\//,
    "better-auth",
  ],
  [/^drizzle-orm$/, "drizzle-orm"],
  [/^react(-dom)?$|^scheduler$/, "React SSR"],
  [/^unenv$|^@cloudflare\/unenv-preset$/, "workerd built-ins"],
];

// 不带文件路径的帧(workerd 内部模块 / V8 原生)。
const URL_GROUPS = [
  [/^cloudflare-internal:d1-api$/, "D1 driver"],
  [/^(cloudflare-internal|cloudflare|node-internal|node|workerd):/, "workerd built-ins"],
];

const PNPM_PKG = /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

/** 源路径(相对 apps/web)→ 所在 workspace 包名;读最近的 package.json,缓存住。 */
const workspaceNameCache = new Map();
function workspacePackageOf(sourcePath) {
  let dir = dirname(resolve(WEB_ROOT, sourcePath));
  while (dir.startsWith(resolve(WEB_ROOT, "../.."))) {
    if (workspaceNameCache.has(dir)) return workspaceNameCache.get(dir);
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const name = JSON.parse(readFileSync(pkg, "utf8")).name ?? dir;
      workspaceNameCache.set(dir, name);
      return name;
    }
    dir = dirname(dir);
  }
  return sourcePath;
}

/** 一个源模块路径 → { pkg, group }。 */
function classifyModule(sourcePath) {
  // 虚拟模块:rolldown 把前缀的 NUL 字面写成两个字符 `\0`。
  if (sourcePath.startsWith("\\0") || sourcePath.startsWith("__vite")) {
    if (sourcePath.includes("tanstack-start")) return { pkg: sourcePath, group: "TanStack Start" };
    if (sourcePath.includes("cloudflare")) return { pkg: sourcePath, group: "workerd built-ins" };
    return { pkg: sourcePath, group: "bundle glue" };
  }
  const m = PNPM_PKG.exec(sourcePath);
  if (m) {
    const pkg = m[1];
    const hit = PACKAGE_GROUPS.find(([re]) => re.test(pkg));
    return { pkg, group: hit ? hit[1] : `vendor: ${pkg}` };
  }
  // 不在 node_modules 里 → 本仓代码(apps/web/src 或 packages/*)。
  return { pkg: workspacePackageOf(sourcePath), group: "app code (@folio/*)" };
}

/**
 * 一个 chunk 的 region 表:按行号升序的 [startLine, endLine, sourcePath]。
 * 行号从 0 起,与 CDP 的 callFrame.lineNumber 一致。
 */
const regionCache = new Map();
function regionsOf(url) {
  if (regionCache.has(url)) return regionCache.get(url);
  const file = join(DIST_SERVER_DIR, url);
  const regions = [];
  if (existsSync(file)) {
    const lines = readFileSync(file, "utf8").split("\n");
    let open = null;
    lines.forEach((line, i) => {
      if (line.startsWith("//#region ")) open = [i, Number.POSITIVE_INFINITY, line.slice(10)];
      else if (line.startsWith("//#endregion") && open) {
        open[1] = i;
        regions.push(open);
        open = null;
      }
    });
  }
  regionCache.set(url, regions);
  return regions;
}

function regionAt(url, line) {
  const regions = regionsOf(url);
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end, path] = regions[mid];
    if (line < start) hi = mid - 1;
    else if (line > end) lo = mid + 1;
    else return path;
  }
  return undefined;
}

/**
 * 一个 CDP callFrame → { group, pkg, module }。group 是报表里那一列;pkg/module 进 JSON 明细。
 */
export function ownerOf(callFrame) {
  const { url, lineNumber, functionName } = callFrame;
  if (!url) {
    if (functionName === "(garbage collector)") return { group: "GC", pkg: "(gc)", module: "(gc)" };
    return { group: "V8 native", pkg: "(native)", module: functionName || "(native)" };
  }
  const byUrl = URL_GROUPS.find(([re]) => re.test(url));
  if (byUrl) return { group: byUrl[1], pkg: url, module: url };
  const source = regionAt(url, lineNumber);
  if (!source) return { group: "bundle glue", pkg: url, module: url };
  return { ...classifyModule(source), module: source };
}
