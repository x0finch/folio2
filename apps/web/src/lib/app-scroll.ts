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
