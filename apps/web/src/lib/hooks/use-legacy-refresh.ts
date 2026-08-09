import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { invalidateFor } from "../queries/refresh";

// **过渡期的「整页刷新」替身。#416 把最后一个域迁完时,这个 hook 连同它的调用点一起删掉。**
//
// 为什么需要它:整页 `router.invalidate()` 重跑 loader,而 loader 里是 `ensureQueryData` ——
// 数据不算旧就不会真拉。于是**任何已经开了 `staleTime` 的域,对整页刷新是静默失效的**:
// 还没迁的写路径(加账户、打标签、改估值设置……)照常调 `router.invalidate()`,画面却停在旧数字,
// 不报错、不报警,只是不动。
//
// 所以在过渡期,还没迁的写路径调这个而不是 `router.invalidate()`:整页那句照旧,外加把已开缓存的
// 域补刷一遍(前缀清单见 refresh.ts 的 `legacy.whole-page`)。某个域迁完了就把它的前缀从那条挪走。
export function useLegacyRefresh(): () => Promise<void> {
  const router = useRouter();
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([router.invalidate(), invalidateFor(queryClient, "legacy.whole-page")]);
  };
}
