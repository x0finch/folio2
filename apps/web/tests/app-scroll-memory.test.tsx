import { afterEach, describe, expect, it } from "vitest";
import { APP_SCROLL_ID, APP_SCROLL_SELECTOR } from "../src/lib/app-scroll";
import { trackAppScroll } from "../src/lib/hooks/use-app-scroll-memory";

// 每个 tab 记住自己滚到哪了(见 use-app-scroll-memory 顶部那段:router 对内滚容器
// 做的是「把上一页的位置带到下一页」,不是「按 key 各记各的」,所以这层由 app 自己管)。
// jsdom 里没有布局,scrollTop 就是个可读写的数 —— 记忆语义测得到,回弹/惯性测不到(那靠真机)。

// 一个假的「路由渲染完了」订阅口:测试自己决定什么时候「切页」。
function fakeRoutes() {
  const listeners = new Set<(pathname: string) => void>();
  return {
    subscribe: (fn: (pathname: string) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    navigateTo: (pathname: string) => {
      for (const fn of listeners) fn(pathname);
    },
  };
}

function mountScroller(): HTMLElement {
  document.body.innerHTML = `<div data-scroll-restoration-id="${APP_SCROLL_ID}"></div>`;
  const el = document.querySelector<HTMLElement>(APP_SCROLL_SELECTOR);
  if (!el) throw new Error("fixture did not mount");
  return el;
}

// 用户滚了一段。jsdom 不会自己发 scroll 事件,手动发一次 —— 真实浏览器里 scrollTop 一变就有。
function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("trackAppScroll", () => {
  it("切走再切回来 → 回到原处;第一次进某个 tab → 顶部", () => {
    const el = mountScroller();
    const routes = fakeRoutes();
    const stop = trackAppScroll(el, routes.subscribe, "/");

    scrollTo(el, 300);
    // 第一次进 /accounts:没记过 → 顶部(不是继承 / 的 300)。
    routes.navigateTo("/accounts");
    expect(el.scrollTop).toBe(0);

    scrollTo(el, 80);
    routes.navigateTo("/");
    expect(el.scrollTop).toBe(300);

    routes.navigateTo("/accounts");
    expect(el.scrollTop).toBe(80);

    stop();
  });

  it("同一个 pathname 再触发一次(loader 重跑 / replace)→ 停在原处,不回顶", () => {
    const el = mountScroller();
    const routes = fakeRoutes();
    const stop = trackAppScroll(el, routes.subscribe, "/");

    scrollTo(el, 240);
    routes.navigateTo("/");
    expect(el.scrollTop).toBe(240);

    stop();
  });

  it("停下来之后不再记、也不再复原", () => {
    const el = mountScroller();
    const routes = fakeRoutes();
    const stop = trackAppScroll(el, routes.subscribe, "/");
    scrollTo(el, 150);
    stop();

    scrollTo(el, 999);
    routes.navigateTo("/accounts");
    // 订阅已撤:切页不再动 scrollTop。
    expect(el.scrollTop).toBe(999);
  });

  it("每次挂载各记一份,不跨会话串味", () => {
    const first = mountScroller();
    const routesA = fakeRoutes();
    const stopA = trackAppScroll(first, routesA.subscribe, "/");
    scrollTo(first, 500);
    stopA();

    // 重新挂载(比如锁屏把整个 App 卸了再装回来)→ 记忆跟着这一次挂载走。
    const second = mountScroller();
    const routesB = fakeRoutes();
    const stopB = trackAppScroll(second, routesB.subscribe, "/accounts");
    routesB.navigateTo("/");
    expect(second.scrollTop).toBe(0);
    stopB();
  });
});
