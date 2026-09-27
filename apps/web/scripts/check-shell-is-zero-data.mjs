// 预渲染出来的文档壳**必须零数据** —— 这条从「__root.tsx 里一句注释」变成「一道闸」。
//
// 为什么非有不可:`dist/client/index.html` 是 Workers Static Assets 直接发给**所有人**的
// 公开文件(边缘可缓存,不经 Worker 的 `no-store` 那条路 —— 那条路为什么存在,见
// lib/server/entry/cache-headers.ts 里记着的那次真实跨用户泄露)。而它是构建机上**真跑一次
// Worker、真请求一次 `/`** 得到的:根路由在服务端算出的任何东西都会被烤进去。ADR 0049 补记里
// 构建时刻、构建机的语言、登录页 DOM 都曾这样一声不吭地烤进去过。今天根路由没有 loader,明天
// 谁加一个,构建照样绿 —— 所以这里把「壳里有什么」做成白名单:**多出任何一条就红**。白名单要改
// 是一次自觉的编辑(连同下面那段「凭什么能发给所有人」一起改),不是顺手绕过。
//
// 跑法:apps/web 的 `build` 脚本在 `vite build` 之后接着跑(CI 的 `pnpm build`、部署的
// `pnpm run build` 因此都跑它)。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(HERE, "..", "dist", "client");

/** 必须存在的壳:缺了它说明预渲染没跑,闸不能当「没东西可查 = 干净」放过。 */
const REQUIRED_SHELLS = ["index.html"];

/** `dist/client` 里不是预渲染出来的 HTML:PWA 离线页是 public/ 里手写的静态页,不带 SSR 负载。 */
const NOT_PRERENDERED = new Set(["offline.html"]);

// ── 白名单 ────────────────────────────────────────────────────────────────────
//
// 允许出现在壳里的**全部**数据。每一条都要能回答「它凭什么可以发给所有人」。

/**
 * 解码后 router 状态的顶层字段。
 * - `manifest`:本次构建的资源文件名(`/assets/*.js`),人人一样,本来就是公开的静态资源。
 * - `matches`:命中了哪几条路由,逐条字段见下。
 * - `lastMatchId`:最后一条 match 的 id,只是路由 id,不含数据。
 * - `dehydratedData`:query 集成的通道,只许是空的,见下。
 */
const ALLOWED_ROUTER_KEYS = new Set(["manifest", "matches", "lastMatchId", "dehydratedData"]);

/**
 * 每条 match 允许的字段(router-core `dehydrateMatch` 的简写)。
 * - `i`:match id(路由 id + 参数),结构信息。
 * - `u`:match 的 updatedAt —— **构建时刻**的时间戳。它是构建机唯一烤进去的变量,人人拿到同一个值,
 *   与任何用户无关;浏览器水合后路由自己会重新加载。
 * - `s`:状态(`success` / `pending`),`ssr`:这条路由是否在服务端渲染 —— 都是结构信息。
 *
 * **不在名单里、出现就红**:`l`(loaderData)、`b`(beforeLoad 返回的 context)、`e`(错误对象,
 * 可能带着服务端的报错细节)、`g`(全局 not-found —— 壳渲成 404 本身就是坏了)。
 */
const ALLOWED_MATCH_KEYS = new Set(["i", "u", "s", "ssr"]);

/**
 * `dehydratedData` 允许的字段:只有 `queryStream` 这根管子本身,且**管子里一条都不许有**。
 * `dehydratedQueryClient`(渲染前就在 QueryClient 里的查询)出现即红 —— 零条查询时集成根本不写它。
 * 允许的查询 / mutation:**无**。任何被 dehydrate 的查询都是构建机上的一次真实读取。
 */
const ALLOWED_DEHYDRATED_KEYS = new Set(["queryStream"]);

// ── 第二道网:就算白名单被人改宽了,这些东西也永远不该出现在壳的数据里 ──────────
//
// 只扫**解码后的数据**(matches + dehydratedData + 流里的查询),不扫整份 HTML,也不扫 manifest ——
// preload 列表里全是 `-accounts-*.js`、`auth-shell-*.js` 这种文件名,整份扫会永远误报。
//
// `session` 也在这张单子里(会话 token 正是最要命的那种泄露):误报风险只在数据块里有一个合法字符串
// 恰好含这个词,而白名单下数据块只剩路由 id / 时间戳 / 状态 —— 撞上它要么是真泄露,要么是某条路由 id
// 里带了 session,那时自觉改这里并写明理由。大小写不敏感(`sessionToken` / `SESSION_ID` 都算)。
const FORBIDDEN_IN_DATA = [
  "userId",
  "user_id",
  "accountId",
  "account_id",
  "enc_credentials",
  "credentials",
  "session",
];

// 邮箱形状反过来扫**整份 HTML**:壳里没有任何正当理由出现一个邮箱,而用户名/邮箱正是 SSR 泄露最先
// 露头的东西。
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// ── 取出 SSR 负载 ─────────────────────────────────────────────────────────────

/** 带 SSR 负载的那段内联脚本:它把整棵 router 状态挂到 `$_TSR.router` 上。 */
const PAYLOAD_MARKER = "$_TSR.router";

/**
 * 属于 TanStack 序列化流的内联脚本(负载本身 + 后续推流 / 收尾那几段,如
 * `$R[19].return(void 0)`)。主题 / 语言 / 样式注入那几段内联脚本不带这些标记,不执行。
 */
const STREAM_MARKERS = ["$_TSR", "$R["];

/** 读查询流的等待上限。流里的东西全是上面那几段脚本同步推进去的,读不完只说明收尾脚本没了。 */
const STREAM_DRAIN_TIMEOUT_MS = 1000;

function streamScriptsOf(html) {
  const scripts = [];
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1];
    if (STREAM_MARKERS.some((marker) => body.includes(marker))) scripts.push(body);
  }
  return scripts;
}

/**
 * 在沙箱里按文档顺序**执行**那几段脚本再读结果,而不是拿正则去啃它。
 *
 * 理由:那段是 seroval 序列化出来的 JS(`$R[7]={…}` 一路互相引用、还夹着真函数和 ReadableStream),
 * 正则读它只会读出一个「大概像」的东西,而这道闸的价值全在「一条都不漏」。它是我们自己刚构建出来的
 * 产物,不是外来输入。
 */
function routerStateOf(scripts) {
  // `self` 必须**就是**那个全局对象:负载脚本写 `self.$_TSR = …` 之后转头读裸的 `$_TSR`
  // (浏览器里 `self === globalThis`)。给 `self` 塞一个普通对象的话,第二行就 ReferenceError。
  const sandbox = { ReadableStream, document: { currentScript: { remove() {} } } };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  createContext(sandbox);
  for (const script of scripts) runInContext(script, sandbox);
  return sandbox.$_TSR?.router;
}

/** 把查询流读干。流没收尾就返回 null(读不完 ≠ 读完了是空的)。 */
async function drain(stream) {
  const reader = stream.getReader();
  const chunks = [];
  // 计时器**不能** unref:流没收尾时事件循环里就只剩它,unref 了 node 会直接退出(exit 13),
  // 而不是走到下面那句能看懂的报错。
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), STREAM_DRAIN_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === null) return null;
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── 检查 ──────────────────────────────────────────────────────────────────────

function checkRouterKeys(router, fail) {
  for (const key of Object.keys(router)) {
    if (!ALLOWED_ROUTER_KEYS.has(key)) fail(`router 状态多出一个顶层字段 ${JSON.stringify(key)}`);
  }
}

function checkMatches(matches, fail) {
  if (!Array.isArray(matches) || matches.length === 0) {
    fail("router 状态里没有 matches —— 负载形状变了,这道闸可能已经失效,去看产物");
    return;
  }
  for (const match of matches) {
    for (const key of Object.keys(match)) {
      if (!ALLOWED_MATCH_KEYS.has(key)) {
        fail(
          `match ${JSON.stringify(match.i)} 多出一个字段 ${JSON.stringify(key)}(白名单:${[...ALLOWED_MATCH_KEYS]})`,
        );
      }
    }
    if (!Number.isFinite(match.u)) {
      fail(`match ${JSON.stringify(match.i)} 的 u 不是时间戳:${JSON.stringify(match.u)}`);
    }
  }
}

function describeState(state) {
  const queries = (state?.queries ?? []).map((q) => q.queryHash);
  return `${queries.length} 条查询 ${JSON.stringify(queries)}、${state?.mutations?.length ?? 0} 条 mutation`;
}

async function checkDehydrated(dehydrated, fail) {
  if (dehydrated === undefined) return [];
  for (const key of Object.keys(dehydrated)) {
    if (!ALLOWED_DEHYDRATED_KEYS.has(key)) {
      const detail = key === "dehydratedQueryClient" ? `:${describeState(dehydrated[key])}` : "";
      fail(`dehydratedData 多出一个字段 ${JSON.stringify(key)}${detail}`);
    }
  }
  const stream = dehydrated.queryStream;
  if (!(stream instanceof ReadableStream)) {
    fail("dehydratedData.queryStream 不是一根流 —— 负载形状变了,这道闸可能已经失效,去看产物");
    return [];
  }
  const chunks = await drain(stream);
  if (chunks === null) {
    fail(`查询流 ${STREAM_DRAIN_TIMEOUT_MS}ms 内没收尾 —— 收尾脚本丢了?无法确认它是空的`);
    return [];
  }
  for (const chunk of chunks) fail(`查询流里推了数据:${describeState(chunk)}`);
  return chunks;
}

function checkForbiddenWords(router, streamed, fail) {
  const { queryStream: _stream, ...dehydratedRest } = router.dehydratedData ?? {};
  const data = JSON.stringify({
    matches: router.matches ?? null,
    lastMatchId: router.lastMatchId ?? null,
    dehydrated: dehydratedRest,
    streamed,
  }).toLowerCase();
  for (const word of FORBIDDEN_IN_DATA) {
    if (data.includes(word.toLowerCase())) fail(`壳的数据块里出现了禁词 ${JSON.stringify(word)}`);
  }
}

async function checkFile(name) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const html = readFileSync(join(CLIENT_DIR, name), "utf8");

  const email = html.match(EMAIL_SHAPED);
  if (email) fail(`HTML 里出现了邮箱形状的字符串:${email[0]}`);

  const scripts = streamScriptsOf(html);
  if (!scripts.some((script) => script.includes(PAYLOAD_MARKER))) {
    // 找不到负载不能当「干净」放过 —— 更可能是 TanStack 换了注入形状,这道闸从此空转。
    fail(`找不到 SSR 负载脚本(marker: ${PAYLOAD_MARKER})—— 这道闸可能已经失效,去看产物`);
    return problems;
  }

  let router;
  try {
    router = routerStateOf(scripts);
  } catch (error) {
    fail(`SSR 负载脚本执行失败,无法解码:${String(error)}`);
    return problems;
  }
  if (!router) return [...problems, "SSR 负载跑完了,却没有 $_TSR.router"];

  checkRouterKeys(router, fail);
  checkMatches(router.matches, fail);
  const streamed = await checkDehydrated(router.dehydratedData, fail);
  checkForbiddenWords(router, streamed, fail);
  return problems;
}

let htmlFiles;
try {
  htmlFiles = readdirSync(CLIENT_DIR).filter((name) => name.endsWith(".html"));
} catch {
  console.error(`[shell-gate] 读不到 ${CLIENT_DIR} —— vite build 没跑成?`);
  process.exit(1);
}

let failed = false;
for (const name of REQUIRED_SHELLS) {
  if (htmlFiles.includes(name)) continue;
  failed = true;
  console.error(`[shell-gate] dist/client/${name} 不存在 —— 预渲染没跑?`);
}

const shells = htmlFiles.filter((name) => !NOT_PRERENDERED.has(name));
for (const name of shells) {
  const problems = await checkFile(name);
  if (problems.length === 0) continue;
  failed = true;
  for (const problem of problems) console.error(`[shell-gate] ${name}: ${problem}`);
}

if (failed) {
  console.error(
    "[shell-gate] 预渲染的文档壳是公开、可被边缘缓存的文件,必须零数据。" +
      "确实要放行新东西的话,去 scripts/check-shell-is-zero-data.mjs 改白名单,并写清它凭什么公开。",
  );
  process.exit(1);
}

console.log(`[shell-gate] ${shells.length} 张预渲染文档壳(${shells.join(", ")}),零数据 ✓`);
