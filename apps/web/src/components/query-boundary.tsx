import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { Component, type ReactNode, Suspense } from "react";
import { RETRY } from "@/lib/queries/constants";

// `useSuspenseQuery` throws on failure; this keeps a failed block local instead of reaching the
// route error page. Class component because React has no function error boundary.
// Once collapsed, the query has no observer and invalidation won't refetch it, so recovery
// comes from `resetKey` (the serialized queryKey) changing or a backoff self-heal timer.
interface ErrorSlotProps {
  resetKey: string;
  /** Clears the cached react-query error before re-mounting. */
  onSelfHeal: () => void;
  fallback: ReactNode;
  children: ReactNode;
}

interface ErrorSlotState {
  failed: boolean;
  seenKey: string;
}

class ErrorSlot extends Component<ErrorSlotProps, ErrorSlotState> {
  state: ErrorSlotState = { failed: false, seenKey: this.props.resetKey };
  private healTimer: ReturnType<typeof setTimeout> | null = null;
  /** Only stretches the self-heal interval; reset on success. */
  private failures = 0;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  // Runs before every render, including the one after getDerivedStateFromError (same resetKey,
  // so the failure isn't cleared).
  static getDerivedStateFromProps(
    props: ErrorSlotProps,
    state: ErrorSlotState,
  ): ErrorSlotState | null {
    if (props.resetKey === state.seenKey) return null;
    return { failed: false, seenKey: props.resetKey };
  }

  // Query errors are logged globally; this catches render errors that would otherwise show as
  // a fetch failure with no trace.
  componentDidCatch(error: unknown) {
    console.error(`[query-boundary ${this.props.resetKey}] caught:`, error);
  }

  // Also on mount: a cached failed query can throw on the boundary's first render.
  componentDidMount() {
    this.scheduleHeal();
  }

  // A failed retry re-schedules itself; the interval backs off so a persistent render bug
  // doesn't flash forever.
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
  /** Usually the serialized queryKey. */
  resetKey: string;
  pending: ReactNode;
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
