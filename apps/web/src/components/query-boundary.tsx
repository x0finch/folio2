import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { Component, type ReactNode, Suspense } from "react";
import { RETRY } from "@/lib/queries/constants";

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
// **停在同一格不动**也能自愈了:塌掉之后挂一个计时器,每隔 `RETRY.selfHeal` 清一次失败态重挂子树
// (清之前先 `reset()` 掉 react-query 记着的那个错误,否则重挂当场又抛同一个)。用户什么都不用做,
// 网络回来或上游缓过来的下一轮就自己长回来 —— 这是「请求失败就该继续请求」的最后一环:
// QueryClient 的退避重试管前半分钟,这个计时器管此后。
interface ErrorSlotProps {
  /** 「这一格在看什么」。变了就把失败态清掉,重新挂载子树。 */
  resetKey: string;
  /** 自愈前先调它,把 react-query 缓存里的那个错误清掉。 */
  onSelfHeal: () => void;
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
  private healTimer: ReturnType<typeof setTimeout> | null = null;
  /** 连续失败次数 —— 只用来拉长自愈间隔,成功一次就归零。 */
  private failures = 0;

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

  // 排一次自愈。**挂载与更新都要排**:错误可能发生在这个边界自己首次挂载的那一瞬
  // (缓存里已经有一个失败的查询,用户切回这个 Tab → 边界全新挂载 → 子树首渲染当场抛),
  // 那一趟走的是 `componentDidMount`,只挂在 update 上的话这一格永远不会自己好。
  componentDidMount() {
    this.scheduleHeal();
  }

  // 成功长回来时 `failed` 已是 false,不再排下一次。失败照旧塌回来,于是又排一次 ——
  // 天然成了「隔一段试一次」,不必自己数轮次。间隔随连败次数拉长(15s → 30s → 60s 封顶):
  // 一直好不了的那种(比如子树渲染本身有毛病)不该每 15 秒闪一下到天荒地老。
  componentDidUpdate() {
    this.scheduleHeal();
  }

  private scheduleHeal() {
    if (!this.state.failed || this.healTimer) return;
    const wait = Math.min(RETRY.selfHeal * 2 ** this.failures, RETRY.selfHealMax);
    this.failures += 1;
    this.healTimer = setTimeout(() => {
      this.healTimer = null;
      this.props.onSelfHeal();
      this.setState({ failed: false });
    }, wait);
  }

  componentWillUnmount() {
    if (this.healTimer) clearTimeout(this.healTimer);
  }

  render() {
    // 长回来了就把连败计数归零:下一次偶发失败照旧从最短间隔开始试。
    if (!this.state.failed) this.failures = 0;
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
  const { reset } = useQueryErrorResetBoundary();
  return (
    <ErrorSlot resetKey={resetKey} onSelfHeal={reset} fallback={failed}>
      <Suspense fallback={pending}>{children}</Suspense>
    </ErrorSlot>
  );
}
