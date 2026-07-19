import { useEffect, useState } from "react";

// 值防抖:快速变化的 value 停止变动 delayMs 后才更新返回值,把「每次输入一变」压成「停顿后一次」。
// 用于搜索框:配 min-length 一起砍掉逐键的上游请求(见 TokenCombobox)。
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
