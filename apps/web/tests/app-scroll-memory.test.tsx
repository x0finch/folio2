import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_SCROLL_ID, APP_SCROLL_SELECTOR } from "../src/lib/app-scroll";
import { locationKey, trackAppScroll } from "../src/lib/hooks/use-app-scroll-memory";

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

// 键怎么取,是这层唯一容易错的地方。片 5 会把页内 tab 用 `replace` 放进 URL —— 那时
// pathname 一直不变,只有查询串在变。键里不带查询串的话:切 tab 被判成「没换位置」→ 不还原,
// 而 router 那边的归零是**无条件**的,于是每切一次都被弹回顶部;两个 tab 还共用同一个记忆槽。
describe("locationKey", () => {
  it("查询串进键 —— 同 pathname 不同查询串是两个位置", () => {
    const home = { pathname: "/", searchStr: "" };
    const tokens = { pathname: "/", searchStr: "?tab=tokens" };
    const perps = { pathname: "/", searchStr: "?tab=perps" };
    expect(locationKey(tokens)).not.toBe(locationKey(perps));
    expect(locationKey(home)).not.toBe(locationKey(tokens));
  });

  it("同一个位置取到同一个键(loader 重跑时要判得出「没换位置」)", () => {
    expect(locationKey({ pathname: "/accounts", searchStr: "?q=a" })).toBe(
      locationKey({ pathname: "/accounts", searchStr: "?q=a" }),
    );
  });
});

// 容器**此刻不够高**时,浏览器会把 scrollTop 夹小。切页内 tab 那一瞬正是这种状态
// (旧面板在淡出、新面板还没挂上,片6),列表还在取数时也一样。所以还原要重试几帧 ——
// 只写一次会「看起来成功了」而位置差一截。jsdom 不夹,所以这里造一个会夹的容器。
function clampingScroller(maxScroll: { value: number }) {
  const el = document.createElement("div");
  el.setAttribute("data-scroll-restoration-id", APP_SCROLL_ID);
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.min(v, maxScroll.value);
    },
  });
  document.body.appendChild(el);
  return el;
}

describe("trackAppScroll 的还原重试", () => {
  it("容器暂时矮 → 下一帧撑起来后仍然还原到位", () => {
    const max = { value: 1000 };
    const el = clampingScroller(max);
    const routes = fakeRoutes();
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        frames.push(cb);
        return frames.length;
      });
    const stop = trackAppScroll(el, routes.subscribe, "/");

    el.scrollTop = 420;
    el.dispatchEvent(new Event("scroll"));
    routes.navigateTo("/other");

    // 换 tab 那一瞬:容器只剩 100 高 → 回来时先被夹到 100。
    max.value = 100;
    routes.navigateTo("/");
    expect(el.scrollTop).toBe(100);

    // 新面板挂上、容器恢复高度 → 重试那一帧把位置补回去。
    max.value = 1000;
    frames.shift()?.(0);
    expect(el.scrollTop).toBe(420);

    stop();
    raf.mockRestore();
  });

  it("一直不够高也会停下来,不无限重试", () => {
    const max = { value: 100 };
    const el = clampingScroller(max);
    const routes = fakeRoutes();
    let scheduled = 0;
    const raf = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        scheduled += 1;
        // 立即跑,模拟「帧一直来,但容器一直矮」。
        cb(0);
        return scheduled;
      });
    const stop = trackAppScroll(el, routes.subscribe, "/");

    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    max.value = 1000;
    el.scrollTop = 900;
    el.dispatchEvent(new Event("scroll"));
    routes.navigateTo("/other");
    max.value = 100; // 永远补不上
    routes.navigateTo("/");

    expect(scheduled).toBeLessThanOrEqual(3);
    stop();
    raf.mockRestore();
  });
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

  it("不同的键各记各的,来回切都停在自己那份位置", () => {
    const el = mountScroller();
    const routes = fakeRoutes();
    const stop = trackAppScroll(el, routes.subscribe, "/?tab=tokens");

    scrollTo(el, 600);
    // 切页内 tab:router 已经把容器清零了,这一层要把该 tab 的位置放回去(首访 → 0)。
    el.scrollTop = 0;
    routes.navigateTo("/?tab=perps");
    expect(el.scrollTop).toBe(0);

    scrollTo(el, 120);
    el.scrollTop = 0;
    routes.navigateTo("/?tab=tokens");
    expect(el.scrollTop).toBe(600);

    el.scrollTop = 0;
    routes.navigateTo("/?tab=perps");
    expect(el.scrollTop).toBe(120);

    stop();
  });

  it("同一个位置再触发一次(loader 重跑)→ 停在原处,不回顶", () => {
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
