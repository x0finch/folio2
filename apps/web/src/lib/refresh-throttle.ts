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
