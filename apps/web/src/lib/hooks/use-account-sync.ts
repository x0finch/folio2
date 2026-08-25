import type { SyncSkipReason } from "@folio/sync";
import { toast } from "@folio/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useTranslations } from "use-intl";
import { invalidateFor } from "@/lib/queries/refresh";

// 「跑完一个账户就刷一次」的节流器。纯逻辑:不引 React、不引 server-only 模块,可直接单测。
//
// 为什么需要它:服务端早就是**先完成先报**(有界并发 6、无序产出),前端也早就逐行收到了完成事件,
// 只是把刷新压在了整轮结束。挪到逐账户之后,刷新会一秒钟连发好几次 —— 并发 6 意味着扎堆完成很常见。
//
// **leading + trailing**,而不是单纯的防抖:第一个账户完成要**立刻**看到动静(防抖会让最快的那个也等一拍),
// 之后一个窗口内的连发合并成一次尾随。窗口 400ms 是照着并发 6 定的:一批 6 个几乎同时回来,
// 合成一次;下一批再来时窗口早过了,又是一次 leading。
export const REFRESH_WINDOW_MS = 400;

export interface RefreshThrottle {
  /** 收到一个账户完成。 */
  bump(): void;
  /** 一轮结束:取消挂起的尾随,并保证「这一轮至少刷过一次、且最后一次一定落地」。 */
  flush(): void;
}

export function createRefreshThrottle(
  run: () => void,
  windowMs: number = REFRESH_WINDOW_MS,
): RefreshThrottle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 窗口内又来了 bump —— 欠一次尾随。
  let pending = false;
  // 这一轮到底刷过没有。**用户级失败时一个 bump 都不会来**(整轮没跑起来),
  // 而那时候更要刷:服务端可能已经落了部分快照(waitUntil)。
  let ran = false;
  // flush 之后这一轮就结束了。晚到的 bump(比如流已经收工、toast 回调还在排队)不该再触发。
  let closed = false;

  const fire = () => {
    ran = true;
    run();
  };

  const openWindow = () => {
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      pending = false;
      fire();
      // 尾随也算一次「刚刷过」→ 重新开窗,否则紧接着的下一个账户会立刻再刷一次。
      openWindow();
    }, windowMs);
  };

  return {
    bump() {
      if (closed) return;
      if (timer === null) {
        fire();
        openWindow();
      } else {
        pending = true;
      }
    },
    flush() {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // 有欠着的尾随 → 立刻补上(最后一个账户的结果一定落地)。
      // 一次都没刷过 → 也补一次(用户级失败那条路)。
      // 两者都不是 → **什么都不做**,否则「只有一个账户的一轮」会刷两次。
      if (pending || !ran) {
        pending = false;
        fire();
      }
    },
  };
}

// 读 /api/sync 的 NDJSON 流。纯逻辑(无 React / server-only import → 可单测)。
//
// 服务端把「跑」和「看」拆开了(见 routes/api/sync.ts):这里断开只是不看了,
// 同步在后台照跑完。所以中途放弃 ≠ 取消同步。

export interface SyncStreamProgress {
  total: number | null; // 服务端逐个吐,开跑时不知道总数 —— 调用方自己知道就传进来
  done: number;
  lastLabel: string | null;
  failures: { accountId: string; error: string }[];
}

// 服务端每行吐一个 AccountSyncResult;用户级失败吐 { fatal }。
interface Line {
  accountId?: string;
  ok?: boolean;
  skipped?: boolean;
  /** 为什么跳过(#527 裁定 2)—— 只有 `missing-credentials` 那种有下一步动作。 */
  skipReason?: SyncSkipReason;
  error?: string;
  fatal?: string;
}

// 把字节流切成一行行 JSON。分片可能落在任意位置,所以要留 buffer。
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Line> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as Line;
        nl = buf.indexOf("\n");
      }
    }
    const rest = buf.trim();
    if (rest) yield JSON.parse(rest) as Line;
  } finally {
    reader.releaseLock();
  }
}

export class SyncStreamError extends Error {}

// 读完整条流,每收到一个账户结果就回调一次。
// labelOf:结果里只有 accountId,展示要的名字由调用方给。
export async function readSyncStream(
  response: Response,
  opts: {
    total: number | null;
    labelOf: (accountId: string) => string;
    onProgress: (p: SyncStreamProgress) => void;
  },
): Promise<SyncStreamProgress> {
  if (!response.ok || !response.body) {
    throw new SyncStreamError(`sync failed: ${response.status}`);
  }
  const progress: SyncStreamProgress = {
    total: opts.total,
    done: 0,
    lastLabel: null,
    failures: [],
  };
  for await (const line of ndjson(response.body)) {
    // 用户级失败:整轮没跑起来(取账户/取凭据挂了)。
    if (line.fatal) throw new SyncStreamError(line.fatal);
    if (!line.accountId) continue;
    progress.done += 1;
    progress.lastLabel = opts.labelOf(line.accountId);
    // 缺凭据(skipped)不算失败 —— 用户还没填 API key 而已。
    if (!line.ok && !line.skipped) {
      progress.failures.push({
        accountId: line.accountId,
        error: line.error ?? "sync failed",
      });
    }
    opts.onProgress({ ...progress, failures: [...progress.failures] });
  }
  return progress;
}

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
  };
}
