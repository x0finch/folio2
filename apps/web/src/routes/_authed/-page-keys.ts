// 四个 page 的名字 —— 单独一个零依赖的文件。外壳(`app-shell`)要认「当前是哪页」,而它同文件住着
// 必须零依赖、零 provider 可渲染的 `AppShellSkeleton`(ADR 0049,见 tests/app-shell-skeleton):
// 注册表 `-pages` 牵着四页的预取链(→ server 侧那堆 query → `cloudflare:workers`),外壳引它就把
// 整条链拖进来了。名字放这儿,外壳只引名字。
const PAGE_KEYS = ["overview", "accounts", "insights", "settings"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

/** 空路径段 = 这一页(`/` → 总览);它是唯一没有自己路径段的页。 */
export const DEFAULT_PAGE = "overview" satisfies PageKey;
/** 路径段里能出现的值:除总览外的三页(`/accounts` …)。总览没有路径段,`/overview` 不是地址。 */
export type PageSlug = Exclude<PageKey, typeof DEFAULT_PAGE>;

export function isPageSlug(value: string): value is PageSlug {
  return value !== DEFAULT_PAGE && (PAGE_KEYS as readonly string[]).includes(value);
}
