import { Component, type ReactNode, Suspense } from "react";

// Suspense + 报错兜底的一小格,给用 `useSuspenseQuery` 的局部区块用。
//
// **为什么需要它**:`useSuspenseQuery` 没有 `isError` 可读 —— 数据没到就挂起,拉失败就往上抛。
// 没有边界的话,一小块列表拉不到会一路冒到路由级错误页,整页塌掉;而这里要的只是「这一格显示
// 一句失败」。React 至今没有函数式的 error boundary,所以下面那个 class 组件是被迫的,不是没想清楚。
//
// **复位靠 `resetKey`,不能只靠重新挂载。** 一旦这一格塌了,失败的子树就被 fallback 顶掉,
// 那条查询也就**没有观察者**了 —— 此后任何 `invalidateQueries` 都不会去重拉它,这一格
// 自己好不了。原先只用 `key` 绑住「这一格在看什么」,而调用方能给的 `key` 是自定义 Tab 的 id,
// 那个 id 在**改目标**时并不变:一次偶发失败之后改指到别的目标,画面还是那句「拉取失败」。
// 所以现在改成绑「在看的那份数据」本身(queryKey 序列化后的字符串):目标一变就复位重试。
//
// 仍然治不好的一种:**停在同一格不动**,那次失败就一直挂着(切走再切回来会重挂,能自愈)。
// 要根治得给失败态配一个「重试」按钮,那是 UI 上的新东西,不在这次修复的范围里。
interface ErrorSlotProps {
  /** 「这一格在看什么」。变了就把失败态清掉,重新挂载子树。 */
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

interface ErrorSlotState {
  failed: boolean;
  /** 上一次渲染时的 resetKey —— 用来判断「看的东西换了没有」。 */
  seenKey: string;
}

class ErrorSlot extends Component<ErrorSlotProps, ErrorSlotState> {
  state: ErrorSlotState = { failed: false, seenKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  // 看的东西换了 → 清掉失败态。React 保证它在每次渲染前跑(含 getDerivedStateFromError
  // 触发的那次重渲染;那一次 resetKey 没变,所以不会把刚置上的失败态又抹掉)。
  static getDerivedStateFromProps(
    props: ErrorSlotProps,
    state: ErrorSlotState,
  ): ErrorSlotState | null {
    if (props.resetKey === state.seenKey) return null;
    return { failed: false, seenKey: props.resetKey };
  }

  // 查询失败已由 router.tsx 的全局 QueryCache.onError 打过日志了,这里补的是**另一半**:
  // 子树的渲染异常同样会落进这个边界,却被显示成「拉取失败」。不留一行就永远查不出来。
  componentDidCatch(error: unknown) {
    console.error(`[query-boundary ${this.props.resetKey}] caught:`, error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function QueryBoundary({
  resetKey,
  pending,
  failed,
  children,
}: {
  /** 「这一格在看什么」——通常是这格那条查询的 queryKey 序列化后的样子。 */
  resetKey: string;
  /** 数据还没到时显示什么(骨架 / 占位符)。 */
  pending: ReactNode;
  /** 拉失败时显示什么。 */
  failed: ReactNode;
  children: ReactNode;
}) {
  return (
    <ErrorSlot resetKey={resetKey} fallback={failed}>
      <Suspense fallback={pending}>{children}</Suspense>
    </ErrorSlot>
  );
}
