// 手机上真正在滚的那个元素是谁(ADR 0042:滚动从 document 挪进 `<main>`)。
// 三处要认它:外壳渲染它、抽屉锁它、切页时记/复原它的位置 —— 所以标识只在这里定义一次。

// 这个属性是 router 认的(`@tanstack/router-core` 的 `scroll-restoration.js`):有它就按
// `[data-scroll-restoration-id="…"]` 存滚动位置,没有就退化成一条按 DOM 位置算出来的
// CSS 路径选择器,渲染结构一变就失配。我们查容器也用同一个属性,不另开第二个真相来源。
const SCROLL_RESTORATION_ID_ATTR = "data-scroll-restoration-id";

export const APP_SCROLL_ID = "app-scroll";
export const APP_SCROLL_SELECTOR = `[${SCROLL_RESTORATION_ID_ATTR}="${APP_SCROLL_ID}"]`;

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
