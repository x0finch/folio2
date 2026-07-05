// 全局 toast 单例桥的纯逻辑(无 JSX/motion,可单测)。在 beUI AnimatedToastStack 之上
// 重建 sonner 式命令式 API,使 toast.loading/success/error(msg,{id}) 调用点零改。
// state 存 module 级 external store,故可在任意事件处理里命令式调用。

import type { ReactNode } from "react";
import type { AnimatedToast, ToastStatus } from "./animated-toast-stack";

const DEFAULT_DURATION = 4200;

let toasts: AnimatedToast[] = [];
const EMPTY: AnimatedToast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;

function emit() {
  toasts = toasts.slice(); // 新引用,供 useSyncExternalStore 感知变更
  listeners.forEach((l) => l());
}

function clearTimer(id: string) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function schedule(id: string, duration: number) {
  clearTimer(id);
  if (duration > 0 && typeof window !== "undefined") {
    timers.set(
      id,
      setTimeout(() => remove(id), duration),
    );
  }
}

export function remove(id: string) {
  clearTimer(id);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

type ToastOpts = { id?: string };

// loading 持久(duration 0,直到被更新为终态);success/error/neutral 走默认时长自动消失。
function upsert(status: ToastStatus, title: ReactNode, opts?: ToastOpts): string {
  const duration = status === "loading" ? 0 : DEFAULT_DURATION;
  const givenId = opts?.id;

  if (givenId && toasts.some((t) => t.id === givenId)) {
    toasts = toasts.map((t) => (t.id === givenId ? { ...t, status, title, duration } : t));
    schedule(givenId, duration);
    emit();
    return givenId;
  }

  const id = givenId ?? `toast-${Date.now()}-${seq++}`;
  toasts = [...toasts, { id, title, status, duration, dismissible: true, createdAt: Date.now() }];
  schedule(id, duration);
  emit();
  return id;
}

export const toast = {
  loading: (title: ReactNode, opts?: ToastOpts) => upsert("loading", title, opts),
  success: (title: ReactNode, opts?: ToastOpts) => upsert("success", title, opts),
  error: (title: ReactNode, opts?: ToastOpts) => upsert("error", title, opts),
  message: (title: ReactNode, opts?: ToastOpts) => upsert("neutral", title, opts),
  dismiss: (id: string) => remove(id),
};

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const getSnapshot = () => toasts;
export const getServerSnapshot = () => EMPTY;

// 供单测:直接观测/重置 store,不触 React/DOM。
export const __toastStore = {
  upsert,
  remove,
  snapshot: () => toasts,
  reset() {
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    toasts = [];
    seq = 0;
  },
};
