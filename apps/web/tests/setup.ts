// jsdom 无 ResizeObserver;beUI Popover / BouncyAccordion 用它测量内容尺寸做动画 → 提供最小 stub。
// (原 @folio/notes-react 包自带,#128 迁入 web 后随组件测试落到 web 的全局 setup。)
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

// jsdom 同样没有 IntersectionObserver;motion/react 的 whileInView 与 TokenCombobox 的懒加载都用它。
// 恒不相交的空 stub 就够:测试关心的是渲染与交互,不是「滚进视口了没」。
class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

if (!("IntersectionObserver" in globalThis)) {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    IntersectionObserverStub;
}

// jsdom 无 matchMedia;主题 hook(use-theme)按 prefers-color-scheme 查询 → 最小 stub(恒 false)。
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }) as unknown as MediaQueryList;
}
