import { useEffect, useState } from "react";

// SSR 安全的媒体查询:首帧返回 false(服务端无 window),挂载后按实际匹配更新并订阅变化。
// 用于「桌面用侧滑 Drawer / 移动用 BottomSheet」这类按视口切换承载壳的场景。
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}
