import type { SyncSkipReason } from "@folio/sync";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useSyncExternalStore } from "react";
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

/** 一个在本轮里失败的账户。`label` 是展示名(服务端只回 accountId)。 */
export interface SyncRoundFailure {
  accountId: string;
  label: string;
  error: string;
}

/**
 * 这一轮同步的进度。**订阅式的 state,不是 toast**(FOL-32 裁定 1):全量同步的进度直接长在
 * 同步面板里 —— 页头一条 toast + 面板一份摘要,是同一件事的两套分母同屏打架。
 */
export interface SyncRound {
  /** 本轮已处理完的账户数(成功 + 失败 + 缺凭据都算处理完)。 */
  done: number;
  /** 本轮要跑的账户数 = 可同步账户数。**不是面板那个分母** —— 后者含手记等不参与同步的来源。 */
  total: number;
  /** 最近一个处理完的账户展示名(没开跑 / 还没有结果时 null)。 */
  current: string | null;
  /** 失败的账户,逐条实时追加。缺凭据(skipped)不算失败。 */
  failures: SyncRoundFailure[];
  /** 整轮没跑起来,或流中途断了。 */
  error: string | null;
}

// 没在跑的那一份。提到模块级:身份稳定,免得每次渲染造一个新对象。**别改它**。
const IDLE_ROUND: SyncRound = {
  done: 0,
  total: 0,
  current: null,
  failures: [],
  error: null,
};

// —— 本轮进度的模块级 store ——
//
// 状态住模块级而不是组件 state:每个页面各自 mount 一份 HeaderSync,放组件 state 的话轮中切页
// 进度就没了(老 toast 是全局的,这算回归)。mutation 在发起它的组件 unmount 后照样跑
// (react-query 的 mutationCache 持有它),回调写这里,新页面的实例挂上来就能读到。
// 只有一格:同一时刻至多一轮在跑(busy 时 `sync()` 早退),后开的一轮覆盖前一轮。
//
// **带 portfolioId,读的时候不匹配当前组合就当空**:A 组合那轮的失败不该挂在 B 组合的面板上
// (琥珀 pill 会对着 B 说 A 的事,点失败行还会去 focus 一个不在 B 里的账户)。切回 A 时它还在 ——
// 「跨轮保留」保留的是**那个组合自己的**上一轮。
let storedRound: { portfolioId: string; round: SyncRound } | null = null;
const roundListeners = new Set<() => void>();

// getSnapshot 要求引用稳定:命中回 store 里那份(只有写入才换引用),不命中恒回同一个 IDLE_ROUND。
function readRound(portfolioId: string): SyncRound {
  return storedRound?.portfolioId === portfolioId ? storedRound.round : IDLE_ROUND;
}

function writeRound(portfolioId: string, next: SyncRound | ((prev: SyncRound) => SyncRound)) {
  storedRound = {
    portfolioId,
    round: typeof next === "function" ? next(readRound(portfolioId)) : next,
  };
  for (const notify of roundListeners) notify();
}

function subscribeRound(listener: () => void) {
  roundListeners.add(listener);
  return () => {
    roundListeners.delete(listener);
  };
}

// busy 同样要跨实例活着(见下面 useIsMutating 那行)—— 按这个 key 数「在飞的那一条」。
const syncRoundKey = (portfolioId: string) => ["sync-round", portfolioId] as const;

// 账户同步的共享逻辑(PageHeader SyncStatus 复用):**一个请求**打到 /api/sync,服务端逐账户回结果,
// 这里边收边推进 `round` 这份进度 state,**并且每完成一个账户就刷一次面板**(#417)。
//
// 以前是浏览器逐个调 syncAccount(并发 3)—— N 次往返,而且用户得一直停在页面上,关标签同步就断在半路。
// 现在服务端用 waitUntil 兜住整轮(见 routes/api/sync.ts),这条流只是观察窗:
// **关掉页面同步照样跑完**,只是看不到进度。
//
// 进度以前走 `toast.loading` 的就地改写。换成 state 是因为那条 toast 与面板各说各的:toast 的分母是
// 可同步账户数(9),面板的分母是组合内全部来源(13),同屏两个数对不上。现在只有面板一处在说话,
// 分母永远是 13(见 SyncPanel 的合成口径)。**toast 仍然留给账户详情里的单账户同步** —— 那一处
// 没有面板可长,横幅是它唯一的落点。
//
// 用 `useMutation` 而不是 `useQuery`:这是按钮触发的写操作,不是声明式读 —— `useQuery` 得配
// `enabled: false` + 手动 `refetch()` 才能当命令用,是官方点名的反模式。换成 mutation 之后
// 「在飞没在飞」交给 `isPending`(不再自己攒 useState)、失败走 `onError`、收尾走 `onSettled`
// (不再手写 try/finally),和仓里其余写操作(manual token 增删等)同一套。
export function useAccountSync(accounts: { id: string; label: string }[], portfolioId: string) {
  const queryClient = useQueryClient();
  // 这一轮的展示名表。放 ref 不放 state:它是命令式的查表把手,变了不该触发渲染,
  // 而且 `mutationFn` 与 onError 都要用同一份 —— onMutate 的返回值只到得了后者。
  const labels = useRef<Map<string, string>>(new Map());
  // 这一轮的刷新节流器。**每轮一个**:它内部有「这一轮刷过没有 / 已收工」的状态,
  // 跨轮复用会让第二轮的第一个账户被上一轮的窗口压住。策略与理由见 lib/refresh-throttle。
  const refresh = useRef<RefreshThrottle | null>(null);
  // 这一轮的进度,读模块级 store(存放的理由见 store 那段)。**跨轮不清空**:上一轮的失败清单在
  // 下一轮开跑前一直留在面板上 —— 一个失败的账户往往仍有旧快照、凭据也齐,摘要那份清单根本不会提它,
  // 面板一收就再没人说过它失败过。已知代价:在账户详情里**单独**同步修好那个账户之后,这条失败仍然
  // 挂着,直到下一轮全量同步才清 —— 那条路不经这个 hook,够不着这份 state。收下:失败静默消失比
  // 失败多挂一会儿更贵。
  const round = useSyncExternalStore(
    subscribeRound,
    () => readRound(portfolioId),
    () => IDLE_ROUND,
  );
  // busy 也从缓存问,不用 `mutation.isPending`:后者是**这一个组件实例**的,轮中切页后新页面的实例
  // 上它是 false —— round 还在推进而面板已经退回静态形态。mutation 本身在 mutationCache 里活着,
  // 按 key 数在飞的那条,哪个实例问都是同一个答案。
  const busy = useIsMutating({ mutationKey: syncRoundKey(portfolioId) }) > 0;

  const mutation = useMutation({
    mutationKey: syncRoundKey(portfolioId),
    onMutate: () => {
      // 服务端只回 accountId,展示名在这边。
      labels.current = new Map(accounts.map((a) => [a.id, a.label]));
      refresh.current = createRefreshThrottle(() => {
        void invalidateFor(queryClient, "sync.round");
      });
      writeRound(portfolioId, {
        done: 0,
        total: accounts.length,
        current: null,
        failures: [],
        error: null,
      });
    },
    mutationFn: async () => {
      // **只递「我在看哪个组合」,不递账户名单**(ADR 0047):这一轮跑哪些账户由服务端按这个组合算。
      // 于是 `accounts.length` 这个分母就是那一轮的条数 —— 两边用的是同一条判据(当前组合的成员 ∧
      // 活跃 ∧ 非手记),摘要里的 `N / M` 与进度条说的是同一件事。以前服务端跑全量、这里的分母是
      // 当前组合那几个,于是在小组合里点同步,进度直接冲过 100%。
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portfolioId }),
      });
      return readSyncStream(response, {
        total: accounts.length,
        labelOf: (accountId) => labels.current.get(accountId) ?? accountId,
        onProgress: (p) => {
          writeRound(portfolioId, (prev) => ({
            ...prev,
            done: p.done,
            total: p.total ?? prev.total,
            current: p.lastLabel,
            // 失败逐条实时出现(裁定 1)—— 不攒到收工再一次性报。
            failures: p.failures.map((f) => ({
              accountId: f.accountId,
              label: labels.current.get(f.accountId) ?? f.accountId,
              error: f.error,
            })),
          }));
          // 这一行到达 = 这个账户**已经处理完**了 —— 成功的那些快照已落库(服务端先写再报),
          // 失败与缺凭据(skipped)的那些没写。所以这一下不保证「有新数据」,只保证「可以去看了」;
          // 多刷一次是幂等的,而漏刷会让先跑完的账户干等整轮结束。
          refresh.current?.bump();
        },
      });
    },
    // 整轮没跑起来,或者流中途断了。收工那一刻 `busy` 就落回 false,所以这句话得留在 `round` 里,
    // 否则失败一闪而过、面板转眼又是一副「一切正常」的样子。
    onError: (err) =>
      writeRound(portfolioId, (prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : String(err),
      })),
    // 成功失败都收工:取消挂起的尾随并保证最后一个账户的结果落地。
    // 一个 bump 都没来过(整轮没跑起来)时它也会刷一次 —— **同步本身可能仍在服务端跑**(waitUntil),
    // 部分快照可能已经落库了。
    onSettled: () => refresh.current?.flush(),
  });

  // 用跨实例的 busy 拦重复点:换页后新实例上 `mutation.isPending` 是 false,拦不住第二轮叠上去。
  const disabled = busy || accounts.length === 0;

  return {
    busy,
    disabled,
    round,
    sync: () => {
      if (disabled) return;
      mutation.mutate();
    },
  };
}
