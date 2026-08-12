import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { appScroller } from "../app-scroll";

// 每个 tab 记住自己滚到哪了:切走再切回来停在原处,第一次进某个 tab 落在顶部。
// 这也正是原生 tab bar 的手感。
//
// **为什么这一层非得自己写**(实测,不是推测 —— `@tanstack/router-core@1.171.13`):
// router 对 **window** 的滚动是「按 URL 各记各的」,但对**内滚元素**做的是另一件事 ——
// `scroll-restoration.js` 在换 key 时把上一页的元素位置**带到下一页**
// (`toElementEntries[selector] ??= fromElementEntries[selector]`)。滚动一挪进容器,
// 后果就是:主页滚到 300 → 点「账户」,账户页开在 300(短页面则被夹到底部);
// 再点回主页,拿到的是账户页那个被夹过的值,原来的 300 已经没了。
// 浏览器实测三次都是这个形状,所以 ADR 0042 里「按 URL 分键恢复、内滚容器天生支持」
// 这句对元素并不成立。
//
// router 唯一的开关是 `scrollToTopSelectors`(装在 `router.tsx` 上):它关掉上面那个
// 「带过去」,改成每次导航把容器滚回顶。代价是它**无条件**执行 —— 元素这一侧没有 window
// 那个 `windowRestored` 闸,所以连前进/后退该复原的那次也一起清零(同样实测过)。
// 两件事在这个版本里是互斥的,配置层拿不到「新页面回顶 + 回来复原」。
//
// 于是分工:router 负责把容器**无条件归零**(万一下面这层没跑起来,退化成「总是回顶」,
// 是安全的那一头);这一层在它之后把记住的位置放回去。顺序有保证 ——
// `subscribers` 是个 `Set`、按插入序 `forEach`,而 router 自己那条在建 router 时
// (`RouterCore` 里的 `setupScrollRestoration`)就订阅了,我们这条在组件 effect 里订阅,必然更晚。

// 位置的键 = pathname + 查询串。**查询串必须进键**:router 那边的归零是无条件的,只改查询串
// 的导航(片 5 要把页内 tab 用 `replace` 放进 URL)照样会把容器清零 —— 键里不带查询串的话,
// 这一层会因为「pathname 没变」提前返回、不还原,用户每切一次页内 tab 就被弹回顶部;
// 而且两个 tab 还会共用同一个记忆槽、互相覆盖。
export function locationKey(location: { pathname: string; searchStr: string }): string {
  return location.pathname + location.searchStr;
}

// 纯机制:容器 + 一个「路由渲染完了」的订阅口 + 当前位置的键。React 那点壳在下面。
// 记忆挂在这次调用的闭包里(不是模块级)—— 锁屏会把整个 App 卸掉再装回来,那时该重新开始。
export function trackAppScroll(
  el: HTMLElement,
  subscribe: (onRendered: (key: string) => void) => () => void,
  initialKey: string,
): () => void {
  const remembered = new Map<string, number>();
  let current = initialKey;

  const onScroll = () => {
    remembered.set(current, el.scrollTop);
  };
  el.addEventListener("scroll", onScroll, { passive: true });

  const unsubscribe = subscribe((key) => {
    if (key === current) return; // loader 重跑、原地重渲染:不是换位置,别把人弹回顶部
    current = key;
    el.scrollTop = remembered.get(key) ?? 0;
  });

  return () => {
    el.removeEventListener("scroll", onScroll);
    unsubscribe();
  };
}

export function useAppScrollMemory(): void {
  const router = useRouter();
  useEffect(() => {
    const el = appScroller();
    if (!el) return;
    return trackAppScroll(
      el,
      (onRendered) => router.subscribe("onRendered", (e) => onRendered(locationKey(e.toLocation))),
      locationKey(router.state.location),
    );
  }, [router]);
}
