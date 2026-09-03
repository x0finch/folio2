import { EASE_OUT } from "@folio/ui/lib/ease";
import { useRouter } from "@tanstack/react-router";
import { animate, useReducedMotion } from "motion/react";
import { useEffect } from "react";

// 四个 tab 之间的交叉淡入(motion 驱动)。
//
// **为什么不是 AnimatePresence,也不是浏览器 View Transitions:**
// - AnimatePresence 要退场那份继续渲旧页,但 TanStack 的 `<Outlet/>` 从实时 store 取子匹配、Accounts/Insights
//   还各自读自己路由的 `?search`;切走后旧页要么渲成新页、要么读不到 match 直接抛错。留不住。
// - View Transitions 是"回调里拍新旧两张快照再淡入"。而本 App 切 tab 要**异步**跑 loader,pending 期间
//   Router 仍显示旧页 —— 浏览器拍到的"新快照"还是旧页,旧→旧淡入等于没动画,数据到了再瞬切。
//   iOS 真机两版都"完全没动画",就是这个时序竞争(桌面缓存热时恰好赢了,掩盖了它)。
//
// **这里的做法:自己控制时序。** `onBeforeNavigate`(还没动 DOM)时把内容区 `cloneNode` 一份、原位盖住;
// 底下 Router 随便加载多久、闪不闪骨架都被盖着;等 `onRendered`(新页**已提交到 DOM**,它从 layout
// effect 里发出)再用 motion 把盖板淡出 —— 旧页真的原地留住、新页真的在下面,没有空帧,不吃加载时长,
// 不依赖任何引擎的快照能力。这就是 View Transitions 想做的事,只是在正确的时刻做。
//
// 盖板是死的 DOM 拷贝(inert / aria-hidden / 不接指针),不订阅任何路由状态,所以也没有"退场副本读实时
// 路由抛错"的问题;充图表全是 SVG,cloneNode 原样带走。**活的**那一份(新页)没有被任何 transform / position
// 包裹 —— absolute 定位到 <main> 的 `<HeaderSync/>` 定位基准不变,不跳。

// 只认顶层 tab(pathname 首段):换 tab 才转场;tab 内深层导航、`?portfolio=` 变化首段不变 → 不动。
const tabOf = (pathname: string) => pathname.split("/")[1] ?? "";

const FADE_DURATION_S = 0.18;
// 兜底:导航失败 / 重定向走别处时 `onRendered` 可能不来 —— 盖板不能永远盖着,到点自己淡掉。
const SETTLE_TIMEOUT_MS = 4000;
// 层叠:盖在内容与页内 `<HeaderSync/>`(z-20)之上,压在移动顶栏(sticky z-30)与 Dock(z-40)之下 ——
// 滚动时 <main> 的盒子会伸到顶栏后面,盖板不该把顶栏遮了。
const OVERLAY_Z = 25;

export function TabTransition() {
  const router = useRouter();
  const reduce = useReducedMotion();

  useEffect(() => {
    // 减弱动态效果:直接瞬切,不盖不淡 —— "减少动效"不该变成"多一层东西"。
    if (reduce) return;

    let overlay: HTMLElement | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const drop = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      overlay?.remove();
      overlay = null;
    };

    const fadeOut = () => {
      const el = overlay;
      if (!el) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      overlay = null;
      // 隔一帧再开始:`onRendered` 出自 layout effect,新页已在 DOM 里,但等浏览器真画一帧再揭盖,
      // 半路揭到骨架/白底的可能就没了。盖板此时仍是全遮的,多这一帧看不出来。
      requestAnimationFrame(() => {
        animate(el, { opacity: 0 }, { duration: FADE_DURATION_S, ease: EASE_OUT }).then(() =>
          el.remove(),
        );
      });
    };

    const unBefore = router.subscribe("onBeforeNavigate", ({ fromLocation, toLocation }) => {
      // `fromLocation` 是 Router 的 resolvedLocation,**首次客户端导航前可能还是 undefined**(初次加载
      // 没走 pending→idle 那条赋值路径)—— 不兜底的话"打开 App 后第一下切 tab"就没动画(实测抓到)。
      // 此刻 history 还没推,`window.location` 就是当前这页的真实路径,拿它兜。
      const fromPath = fromLocation?.pathname ?? window.location.pathname;
      if (tabOf(fromPath) === tabOf(toLocation.pathname)) return;
      const main = document.querySelector<HTMLElement>("[data-shell-main]");
      if (!main) return;

      // 连点:上一块盖板不管淡到哪都先撤,重新拍当前这一屏。
      drop();

      const rect = main.getBoundingClientRect();
      const clone = main.cloneNode(true) as HTMLElement;
      clone.removeAttribute("data-shell-main");
      // 别留重复 id(label/for、aria 会被带偏);拷贝只是画面,不是可交互的页。
      for (const el of clone.querySelectorAll("[id]")) el.removeAttribute("id");
      clone.setAttribute("aria-hidden", "true");
      clone.setAttribute("inert", "");
      // `fixed` + 当前几何:不管页面滚到哪、<main> 有多少 padding,拷贝都和活的那份逐像素对齐;
      // 底色必须实铺(读 body 的当前底色,明暗主题都对)—— 页面大片留白,不铺底色新页会从缝里透上来。
      Object.assign(clone.style, {
        position: "fixed",
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: "0",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: String(OVERLAY_Z),
        background: getComputedStyle(document.body).backgroundColor,
      });
      document.body.appendChild(clone);
      overlay = clone;
      settleTimer = setTimeout(fadeOut, SETTLE_TIMEOUT_MS);
    });

    const unRendered = router.subscribe("onRendered", fadeOut);

    return () => {
      unBefore();
      unRendered();
      drop();
    };
  }, [router, reduce]);

  return null;
}
