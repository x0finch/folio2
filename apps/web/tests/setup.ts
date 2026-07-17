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
