import { useSyncExternalStore } from "react";

// 一条**每浏览器**的展示偏好,存 localStorage(与主题 / 闲置锁同一处)。界面语言与展示币种各用一份。
//
// 为什么不再是 cookie:HTML 文档现在是构建期产出的静态文件(ADR 0049 补记),服务器根本不参与,
// 也就没有谁能在请求里读 cookie、按它塑形页面。偏好只能由浏览器自己读,那就放浏览器自己的存储。
//
// 形状是一个外部 store + `useSyncExternalStore`,而不是 `useState` + 挂载后读:
//   · **补水那一帧必须和静态壳逐字一致**,所以服务端 / 补水读的是 `serverValue`(壳就是按它渲的),
//     补水完成后 React 自己换成真值再渲一次 —— 不报 mismatch,也不必手写 mounted 标志。
//   · 写完同步通知同标签的所有订阅者(`storage` 事件只在**别的**标签触发,本标签收不到)。
//
// storage 不可用(隐私模式、被禁)时读回 `parse(null)`,写静默丢弃 —— 本次会话照样生效,只是不持久。
export function storedPreference<T extends string>(
  key: string,
  parse: (raw: string | null) => T,
  serverValue: T,
) {
  const listeners = new Set<() => void>();

  function read(): T {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {}
    return parse(raw);
  }

  // 写之前过一遍 parse:存进去的一定是认得的值,读侧不必天天兜底。
  function write(next: string): void {
    try {
      localStorage.setItem(key, parse(next));
    } catch {}
    for (const notify of listeners) notify();
  }

  function subscribe(notify: () => void): () => void {
    listeners.add(notify);
    // 别的标签改了同一个键(或整表被清,key === null)→ 跟着换。
    const onStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) notify();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(notify);
      window.removeEventListener("storage", onStorage);
    };
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, read, () => serverValue);
  }

  return { read, write, useValue };
}
