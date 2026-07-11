// jsdom 无 ResizeObserver;BouncyAccordion(beUI)用它测量内容高度做展开动画 → 提供最小 stub。
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
