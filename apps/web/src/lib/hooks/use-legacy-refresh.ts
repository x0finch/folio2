import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { invalidateFor } from "../queries/refresh";

// **过渡期的「整页刷新」替身。#416 把最后一个域迁完时,这个 hook 连同它的调用点一起删掉。**
//
// 为什么需要它:整页 `router.invalidate()` 重跑 loader,而 loader 里是 `ensureQueryData` ——
// **它只要缓存里有数据就原样返回,压根不看 stale**(react-query 源码:`cachedData !== undefined`
// 就直接 resolve;`revalidateIfStale` 不开的话连后台重拉都不发)。所以**一个域的读一旦搬进来,
// 整页刷新就再也刷不动它了 —— 和 `staleTime` 设成多少无关**。还没迁的写路径照常调
// `router.invalidate()`,画面却停在旧数字:不报错、不报警,只是不动。
//
// 这一条是 e2e 抓出来的(#413):账户的读迁完、写还没迁那一片,加账户之后账户行就不出现了。
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
