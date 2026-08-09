import { Component, type ReactNode, Suspense } from "react";

// Suspense + 报错兜底的一小格,给用 `useSuspenseQuery` 的局部区块用。
//
// **为什么需要它**:`useSuspenseQuery` 没有 `isError` 可读 —— 数据没到就挂起,拉失败就往上抛。
// 没有边界的话,一小块列表拉不到会一路冒到路由级错误页,整页塌掉;而这里要的只是「这一格显示
// 一句失败」。React 至今没有函数式的 error boundary,所以下面那个 class 组件是被迫的,不是没想清楚。
//
// **重置靠 `key`**:出错后本格就停在失败态,直到被重新挂载。调用方用 `key` 绑住「这一格在看什么」
//(比如自定义 Tab 的 id),切走再切回来自然就是一次重挂,不用另造一套 reset 通道。
class ErrorSlot extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function QueryBoundary({
  pending,
  failed,
  children,
}: {
  /** 数据还没到时显示什么(骨架 / 占位符)。 */
  pending: ReactNode;
  /** 拉失败时显示什么。 */
  failed: ReactNode;
  children: ReactNode;
}) {
  return (
    <ErrorSlot fallback={failed}>
      <Suspense fallback={pending}>{children}</Suspense>
    </ErrorSlot>
  );
}
