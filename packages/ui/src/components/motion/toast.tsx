"use client";
// 全局 toast 出口:命令式 `toast`(逻辑在 toast-store)+ 挂载一次的 <Toaster>。
// 消费端 `import { toast, Toaster } from "@folio/ui"`,调用点与 sonner 时代零改。

import { useSyncExternalStore } from "react";
import { AnimatedToastStack } from "./animated-toast-stack";
import { getServerSnapshot, getSnapshot, remove, subscribe, toast } from "./toast-store";

export { toast };

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return (
    <AnimatedToastStack toasts={list} onDismiss={remove} position="bottom-right" placement="fixed" />
  );
}
