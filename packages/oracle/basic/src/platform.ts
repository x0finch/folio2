// 平台 = 一笔持仓**待在哪里** —— 链 ∪ 场馆(见 CONTEXT.md 的「Platform」)。
// platformKey 与 tokenRef 的命名者同形(`evm:<chainId>` / `<slug>`),因为它就是那个命名者:
// 链上持仓的命名者是它所在的链,场馆持仓的命名者是场馆本身(见 `@folio/sync` 的 `platformOf`)。
//
// 本层只有「一个平台叫什么、图长什么样」这一件事。**没有 `PlatformRow`、没有否定缓存的形状** ——
// 那是缓存的事,归 entry(见 entry/platforms.ts 的 `PlatformEntry`)。
export interface PlatformMeta {
  key: string;
  name: string;
  logo?: string;
}
