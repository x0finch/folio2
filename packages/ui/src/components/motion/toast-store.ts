// 全局 toast 单例桥的纯逻辑(无 JSX/motion,可单测)。在 beUI AnimatedToastStack 之上
// 重建 sonner 式命令式 API,使 toast.loading/success/error(msg,{id}) 调用点零改。
// state 存 module 级 external store,故可在任意事件处理里命令式调用。

import type { ReactNode } from "react";
import type { AnimatedToast, AnimatedToastAction, ToastStatus } from "./animated-toast-stack";

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
  // `Number.isFinite` 兜底:`duration: Infinity` 若直接进 setTimeout 会被当 0、toast 秒删 —— 非有限
  // 值一律按「常驻」处理(不排定时器),与 `0 = 常驻` 同义。
  if (duration > 0 && Number.isFinite(duration) && typeof window !== "undefined") {
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

// 渲染层(renderToast / AnimatedToastStack)一直支持 action / description / 自定时长 / 不可关,
// 只是这个命令式出口先前没把它们透传 —— 于是「带按钮的 toast」根本发不出来。补齐:
//   · action —— 行内按钮({label,onClick}),给「有新版本 → 更新」这类需要一步操作的 toast。
//   · duration —— 覆盖按状态定的默认时长;传 0 = 常驻(不自动消失,直到用户关或代码 dismiss)。
//   · dismissible —— 默认 true;显式 false 去掉关闭按钮(接管态才该用,慎用)。
type ToastOpts = {
  id?: string;
  description?: ReactNode;
  action?: AnimatedToastAction;
  /** 覆盖默认时长(毫秒);`0` = 常驻,不自动消失。 */
  duration?: number;
  dismissible?: boolean;
};

// loading 持久(duration 0,直到被更新为终态);success/error/neutral 走默认时长自动消失。
// opts.duration 若给出则覆盖上面这条默认(含传 0 让终态 toast 也常驻)。
function upsert(status: ToastStatus, title: ReactNode, opts?: ToastOpts): string {
  const duration = opts?.duration ?? (status === "loading" ? 0 : DEFAULT_DURATION);
  const { id: givenId, description, action, dismissible = true } = opts ?? {};

  if (givenId && toasts.some((t) => t.id === givenId)) {
    toasts = toasts.map((t) =>
      t.id === givenId ? { ...t, status, title, duration, description, action, dismissible } : t,
    );
    schedule(givenId, duration);
    emit();
    return givenId;
  }

  const id = givenId ?? `toast-${Date.now()}-${seq++}`;
  toasts = [
    ...toasts,
    { id, title, status, duration, description, action, dismissible, createdAt: Date.now() },
  ];
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
