// 边缘缓存的默认档:**没有显式说「我可以被缓存」的响应,一律不进任何缓存。**
//
// 为什么必须有这一层 —— 这是一个真实发生过的跨用户数据泄露:
//
// `wrangler.jsonc` 开着 `cache: { enabled: true }`(logo 代理靠它命中边缘缓存,ADR 0008),
// 而 **CF 的边缘缓存键只有 URL,不含 Cookie**。SSR 的 `/` 在登录态下会把用户的净值和持仓
// 直接渲进 HTML;这份响应此前不带任何 `cache-control`,于是 CF 按自己的默认启发式把它缓存下来。
// 下一个用户请求同一个 URL → 边缘直接命中 → 拿到的是**上一个用户的页面**。跨浏览器、跨账号。
//
// 实测证据(修复前,对部署好的 worker 发三次 HEAD `/`):
//   无 Cookie                        → cf-cache-status: HIT, age: 736
//   Cookie: …session_token=<假 A>    → cf-cache-status: HIT, age: 736
//   Cookie: …session_token=<假 B>    → cf-cache-status: HIT, age: 736
// 三次 `age` 完全相同 → 同一份副本,Cookie 对缓存键毫无影响。`/accounts` 同样 HIT。
//
// 修法不是关掉 `cache.enabled`(logo 代理需要它),而是把默认档反过来:
// **可缓存必须显式声明**。自己写了 `cache-control` 的响应保持原样 —— logo 代理的
// `public/private, max-age=…`、静态资产的 `public, max-age=0, must-revalidate` 都不受影响。
// 剩下所有东西(SSR 文档、server function 响应)落到 `private, no-store`。
//
// 这与本仓「贵的那档必须由结构显式选中」是同一条规矩(见 apps/web/vitest.config.ts 的
// 环境选择),只是这里贵的东西是安全,不是时间。**不要把默认档改成「可缓存」再逐个打补丁** ——
// 漏一个端点的代价是把一个用户的持仓发给另一个用户。
const PRIVATE_NO_STORE = "private, no-store";

// `no-store` 已经足够挡住缓存;`Vary: Cookie` 是第二道 —— 若某个中间层忽略了 `no-store`,
// 至少缓存键会按会话分开,而不是所有人共用一份。不是替代关系,所以两个都发。
const VARY_COOKIE = "cookie";

const hasVaryCookie = (vary: string | null): boolean =>
  vary?.split(",").some((v) => v.trim().toLowerCase() === VARY_COOKIE || v.trim() === "*") ?? false;

// 给响应补上默认的「不可缓存」声明。已显式声明 `cache-control` 的原样放行。
export function withDefaultNoStore(res: Response): Response {
  // WebSocket 升级(101)不能被重新构造 —— 原样放行。当前没有这种路径,但克隆一个
  // Response 时顺手守住比事后查一个诡异的 500 便宜。
  if (res.status === 101 || (res as { webSocket?: unknown }).webSocket) return res;
  if (res.headers.has("cache-control")) return res;

  const headers = new Headers(res.headers);
  headers.set("cache-control", PRIVATE_NO_STORE);
  if (!hasVaryCookie(headers.get("vary"))) headers.append("vary", VARY_COOKIE);

  // body 按引用交出去(ReadableStream),不缓冲。null-body status(204/304)的 body 本就是 null。
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
