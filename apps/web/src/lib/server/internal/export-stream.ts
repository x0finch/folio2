import {
  AccountStore,
  ManualStore,
  type SnapshotBalance,
  SnapshotStore,
  TransferStore,
} from "@folio/db";
import { Effect, Option, Stream } from "effect";
import { safeView } from "../../creds";
import {
  accountRecord,
  manualActivityRecord,
  metaRecord,
  ndjsonLine,
  snapshotRecord,
  tokenRecord,
} from "../../export";
import { credentialSpecs } from "./connector-registry";
import type { DbStores } from "./oracle";

// 导出那条 NDJSON 流。**路由只剩鉴权 + 跑一次**,流本身住在这里 —— 与 `/api/sync` 的
// `sync-ndjson.ts` 同一个形状,理由也一样:handler 里的东西测不到,这里的测得到
// (见 tests/server/export-stream.test.ts 钉的分页边界)。

// 每页快照数:配 inArray(≤ 50 ids) 取余额,远低于 D1 100 绑定参数上限。
const SNAPSHOT_PAGE = 50;

const encoder = new TextEncoder();

// 导出的四段内容,拼成**一条 Effect Stream**(#394 T7)。
//
// 以前是 `new ReadableStream({ async start(controller) { … } })`:一个 async 生产者,里头四段各自
// `await db.xxx(userId)`(过渡门面 → 每次各建一次 layer、各跑一次 `runPromise`),还要自己
// `try/catch` 再 `controller.error`。改成 Stream 之后这三件事各归各位 —— 顺序是 `concat`,
// 分页是 `paginateEffect`,失败沿流传播(`toReadableStream` 自己会 error 掉那个 ReadableStream)。
//
// **服务在建流之前就解析好**(闭包里的 `transfer` / `accounts` / …),所以流本身的 `R` 是 `never`,
// `toReadableStream` 才收得下。这正是 CODING.md 那条「把已解析好的服务对象当参数传给内部函数」。
export const exportStream = (): Effect.Effect<ReadableStream<Uint8Array>, never, DbStores> =>
  Effect.gen(function* () {
    const [transfer, accounts, snapshots, manual] = [
      yield* TransferStore,
      yield* AccountStore,
      yield* SnapshotStore,
      yield* ManualStore,
    ];
    const specsByType = credentialSpecs();

    const meta = Stream.make(metaRecord(Date.now())); // 首行:版本号等

    // Token 行(#204):必须在 snapshot / activity 之前 —— 它们按 token_id 引用,
    // 单遍导入据流内顺序先建 Token 映射。
    const tokens = Stream.fromIterableEffect(transfer.listTokensForExport()).pipe(
      Stream.map(tokenRecord),
    );

    // 安全投影(无需解密):public 原样、semi 打码、secret 丢弃 —— 绝不导出完整密钥。
    const accountLines = Stream.fromIterableEffect(accounts.list()).pipe(
      Stream.mapEffect((a) =>
        Effect.map(accounts.getRawCreds(a.id), (raw) => {
          const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
          return accountRecord(a, safeView(specsByType[a.connectorId] ?? [], stored));
        }),
      ),
    );

    // 快照:分页拉取,每页取该页余额、流式写出 → 内存恒定,绕开参数上限。
    // `paginateEffect` 的「下一页」是 `Option`:`none` 就是没有下一页 —— 原来那两个 `break`
    // (空页 / 不满一页)现在是同一个表达式里的两个条件。
    const snapshotLines = Stream.paginateEffect(0, (offset: number) =>
      Effect.gen(function* () {
        const page = yield* snapshots.listPage(SNAPSHOT_PAGE, offset);
        const pageBalances =
          page.length === 0 ? [] : yield* snapshots.balancesFor(page.map((s) => s.id));
        const bySnapshot = new Map<string, SnapshotBalance[]>();
        for (const b of pageBalances) {
          const arr = bySnapshot.get(b.snapshotId);
          if (arr) arr.push(b);
          else bySnapshot.set(b.snapshotId, [b]);
        }
        // 不满一页(含空页)就是最后一页 —— 原来那两个 `break` 现在是同一个条件。
        const next =
          page.length < SNAPSHOT_PAGE ? Option.none<number>() : Option.some(offset + SNAPSHOT_PAGE);
        return [page.map((s) => snapshotRecord(s, bySnapshot.get(s.id) ?? [])), next] as const;
      }),
    ).pipe(Stream.flattenIterables);

    // 手记账本(#204):最后写,accountId/tokenId 引用前面已建的账户/Token。
    const activities = Stream.fromIterableEffect(manual.listAllActivity()).pipe(
      Stream.map(manualActivityRecord),
    );

    const bytes = meta.pipe(
      Stream.concat(tokens),
      Stream.concat(accountLines),
      Stream.concat(snapshotLines),
      Stream.concat(activities),
      Stream.map((record: unknown) => encoder.encode(ndjsonLine(record))),
    );
    return Stream.toReadableStream(bytes);
  });
