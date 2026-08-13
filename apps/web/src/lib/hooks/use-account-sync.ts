import { toast } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useTranslations } from "use-intl";
import { invalidateFor } from "../queries/refresh";
import { createRefreshThrottle, type RefreshThrottle } from "../refresh-throttle";
import { readSyncStream } from "../sync-stream";

// 账户同步的共享逻辑(PageHeader SyncStatus 复用):**一个请求**打到 /api/sync,服务端逐账户回结果,
// 这里边收边更新 toast 进度,**并且每完成一个账户就刷一次面板**(#417)。
//
// 以前是浏览器逐个调 syncAccount(并发 3)—— N 次往返,而且用户得一直停在页面上,关标签同步就断在半路。
// 现在服务端用 waitUntil 兜住整轮(见 routes/api/sync.ts),这条流只是观察窗:
// **关掉页面同步照样跑完**,只是看不到进度。
//
// 用 `useMutation` 而不是 `useQuery`:这是按钮触发的写操作,不是声明式读 —— `useQuery` 得配
// `enabled: false` + 手动 `refetch()` 才能当命令用,是官方点名的反模式。换成 mutation 之后
// 「在飞没在飞」交给 `isPending`(不再自己攒 useState)、失败走 `onError`、收尾走 `onSettled`
// (不再手写 try/finally),和仓里其余写操作(manual token 增删等)同一套。
export function useAccountSync(accounts: { id: string; label: string }[]) {
  const t = useTranslations("Accounts");
  const queryClient = useQueryClient();
  // 这一轮的 toast 句柄与展示名表。放 ref 不放 state:它们是命令式的 UI 把手,变了不该触发渲染,
  // 而且 `mutationFn` 与 onSuccess/onError 都要用同一份 —— onMutate 的返回值只到得了后者。
  const toastId = useRef<ReturnType<typeof toast.loading> | undefined>(undefined);
  const labels = useRef<Map<string, string>>(new Map());
  // 这一轮的刷新节流器。**每轮一个**:它内部有「这一轮刷过没有 / 已收工」的状态,
  // 跨轮复用会让第二轮的第一个账户被上一轮的窗口压住。策略与理由见 lib/refresh-throttle。
  const refresh = useRef<RefreshThrottle | null>(null);

  const mutation = useMutation({
    onMutate: () => {
      // 服务端只回 accountId,展示名在这边。
      labels.current = new Map(accounts.map((a) => [a.id, a.label]));
      refresh.current = createRefreshThrottle(() => {
        void invalidateFor(queryClient, "sync.round");
      });
      toastId.current = toast.loading(
        t("syncingProgress", { done: 0, total: accounts.length, current: "…" }),
      );
    },
    mutationFn: async () => {
      const response = await fetch("/api/sync", { method: "POST" });
      return readSyncStream(response, {
        total: accounts.length,
        labelOf: (accountId) => labels.current.get(accountId) ?? accountId,
        onProgress: (p) => {
          toast.loading(
            t("syncingProgress", {
              done: p.done,
              total: p.total ?? accounts.length,
              current: p.lastLabel ?? "…",
            }),
            { id: toastId.current },
          );
          // 这一行到达 = 这个账户**已经处理完**了 —— 成功的那些快照已落库(服务端先写再报),
          // 失败与缺凭据(skipped)的那些没写。所以这一下不保证「有新数据」,只保证「可以去看了」;
          // 多刷一次是幂等的,而漏刷会让先跑完的账户干等整轮结束。
          refresh.current?.bump();
        },
      });
    },
    onSuccess: (final) => {
      if (final.failures.length > 0) {
        toast.error(
          t("syncFailed", {
            count: final.failures.length,
            details: final.failures
              .map((f) => `${labels.current.get(f.accountId) ?? f.accountId}: ${f.error}`)
              .join("; "),
          }),
          { id: toastId.current },
        );
      } else {
        toast.success(t("synced", { count: final.done }), { id: toastId.current });
      }
    },
    // 整轮没跑起来,或者流中途断了。就地改写那条 loading,不另起一条。
    onError: (err) =>
      toast.error(
        t("syncFailed", {
          count: accounts.length,
          details: err instanceof Error ? err.message : String(err),
        }),
        { id: toastId.current },
      ),
    // 成功失败都收工:取消挂起的尾随并保证最后一个账户的结果落地。
    // 一个 bump 都没来过(整轮没跑起来)时它也会刷一次 —— **同步本身可能仍在服务端跑**(waitUntil),
    // 部分快照可能已经落库了。
    onSettled: () => refresh.current?.flush(),
  });

  const disabled = mutation.isPending || accounts.length === 0;

  return {
    busy: mutation.isPending,
    disabled,
    sync: () => {
      if (disabled) return;
      mutation.mutate();
    },
    /**
     * 同上,但**等这一轮真的结束**才 resolve(片10)。
     *
     * 下拉刷新那个组件会 `await onRefresh()` 再决定什么时候收回指示器 —— 拿即发即忘的 `sync`
     * 喂给它,回调会立刻 resolve,指示器于是先收回、下一帧因为 `refreshing` 变真又弹出来,
     * 表现成可见的抖一下。
     *
     * 失败不往外抛:错误已经由 `onError` 弹了 toast,再抛一次只会让调用方多写一段 catch
     * 去处理「已经处理过的错误」。
     */
    syncAsync: async () => {
      if (disabled) return;
      try {
        await mutation.mutateAsync();
      } catch {
        // onError 已经报过了。
      }
    },
  };
}
