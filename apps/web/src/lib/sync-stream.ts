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
