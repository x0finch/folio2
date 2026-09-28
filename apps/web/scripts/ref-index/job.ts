import { GlobalDatabase, provideRemoteDbClient, type RemoteSql } from "@folio/db";
import { GlobalRefIndexService } from "@folio/oracle";
import { type CoinGeckoConfig, coinGeckoUpstreamLayers } from "@folio/oracle-upstream-coingecko";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { toError } from "../../src/lib/server/errors";

// 刷全局映射表的**第二个装配点**(FOL-85,ADR 0056)。第一个曾是 Worker 的 23:00 cron —— 同一个
// `GlobalRefIndexService`、同一张 `GlobalDatabase` 门票、同一个 CoinGecko adapter,只是:
//   · 连接不是 D1 绑定,是调用方给的一条 SQL 传输(D1 REST / 本机 SQLite / 干跑包装);
//   · 跑在 Node 上,没有 10ms CPU 的顶。
// **这里一行业务逻辑都没有**:拉两个端点 → 纯转换(`toRefIndexRows`)→ 差量写(`putAll`:keyset 扫库、
// 只写真变了的行、空全集不动、按 upstream 作用域删),全在原来的包里,Worker 那边有过的测试照样钉着。

/** 一轮的账:刷之前表上最近一次变更的时刻,上游给了多少行 / 跳过多少 / 哪些链对不上,落库改增删各几行。 */
export interface RefreshReport {
  readonly lastRefreshedAt: number | null;
  readonly rows: number;
  readonly skipped: number;
  readonly unmatchedPlatforms: readonly string[];
  readonly inserted: number;
  readonly updated: number;
  readonly deleted: number;
}

/**
 * 跑一轮。失败 → reject 一个 `Error`:上游的类型化失败经 app 的 `toError` 变成人话(与 Worker 那边同一句),
 * 传输层的 reject(D1 挂了)是 defect,原样拿出来。
 */
export async function refreshRefIndex(
  sql: RemoteSql,
  coingecko: CoinGeckoConfig,
): Promise<RefreshReport> {
  const program = Effect.gen(function* () {
    const svc = yield* GlobalRefIndexService;
    const before = yield* svc.refreshedAt();
    const result = yield* svc.warm();
    return { lastRefreshedAt: Option.getOrNull(before), ...result };
  });
  const services = GlobalRefIndexService.Default.pipe(
    Layer.provide(Layer.merge(GlobalDatabase.Default, coinGeckoUpstreamLayers(coingecko).token)),
  );
  const exit = await Effect.runPromiseExit(
    program.pipe(provideRemoteDbClient(sql), Effect.mapError(toError), Effect.provide(services)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.squash(exit.cause);
  throw failure instanceof Error ? failure : new Error(String(failure));
}

/** 这一轮经传输层发了什么:读几条、写几批几条(干跑时写的那部分只数不发)。 */
export interface SqlTally {
  reads: number;
  writeBatches: number;
  writeStatements: number;
}

/**
 * 给传输层套一层计数;`dryRun` 时**写一条都不往下发**(读照常,差量要对着真实的表算)。
 *
 * 判据是「这是不是一批写」:`putAll` 的读全走 `query`(keyset 分页的 SELECT),写全走 `batch`。
 * 万一哪天有一条写从 `query` 过来(method `run`),干跑同样把它拦下 —— 宁可少读,不可多写。
 */
export function tallied(inner: RemoteSql, dryRun: boolean): { sql: RemoteSql; tally: SqlTally } {
  const tally: SqlTally = { reads: 0, writeBatches: 0, writeStatements: 0 };
  return {
    tally,
    sql: {
      query: async (stmt) => {
        if (stmt.method === "run") {
          tally.writeBatches += 1;
          tally.writeStatements += 1;
          return dryRun ? [] : inner.query(stmt);
        }
        tally.reads += 1;
        return inner.query(stmt);
      },
      batch: async (stmts) => {
        if (stmts.length === 0) return [];
        tally.writeBatches += 1;
        tally.writeStatements += stmts.length;
        return dryRun ? stmts.map(() => []) : inner.batch(stmts);
      },
    },
  };
}
