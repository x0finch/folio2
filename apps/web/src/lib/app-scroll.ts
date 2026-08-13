// 手机上真正在滚的那个元素是谁(ADR 0042:滚动从 document 挪进 `<main>`)。
// 三处要认它:外壳渲染它、抽屉锁它、切页时记/复原它的位置 —— 所以标识只在这里定义一次。

// 标记用**类名**而不是 `data-scroll-restoration-id`(片10 换的):滚动容器现在是 registry 装出来的
// `<PullToRefresh>` 渲染的那个 `<section>` —— 它只收 `className`,不收任意属性,而它是 vendored 件、
// 一个字不改。
//
// 换掉那个属性不吃亏:它原本的用处是给 router 的**元素级滚动恢复**一个稳定键,而我们**根本没用**
// 那条路(它对元素做的是「把上一页位置带到下一页」,详见 `use-app-scroll-memory` 顶部那段) ——
// 位置由我们自己记。剩下两个用处(router 的 `scrollToTopSelectors`、这边查容器)都是选择器,
// 类选择器一样使。
export const APP_SCROLL_ID = "app-scroll";
export const APP_SCROLL_SELECTOR = `.${APP_SCROLL_ID}`;

// 没有外壳的页面(登录页 / 锁屏)返回 null —— 调用方一律要能接受这个。
export function appScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>(APP_SCROLL_SELECTOR);
}

// 这个元素**此刻**是不是真的在滚:手机上是 `auto`(内滚),桌面 `lg:` 把 overflow 还回 `visible`
// (滚的是整页)。两种模型并存是有意的(ADR 0042),所以「谁在滚」只能问计算样式,不能靠断点写死。
// 注意:已经被锁住(`overflow-y: hidden`)的容器在这里会答 false —— 调用方若要处理「锁着的时候」,
// 得自己先判(见 `use-scroll-lock` 的 `lockTarget`)。
export function isScrolling(el: HTMLElement): boolean {
  const { overflowY } = getComputedStyle(el);
  return overflowY === "auto" || overflowY === "scroll";
}
