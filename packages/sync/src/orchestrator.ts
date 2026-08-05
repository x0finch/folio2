import type { Balance, Note } from "@folio/connectors-basic";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import { Duration, Effect, Schedule } from "effect";
import { FetchBalancesError, messageOf, toFetchBalancesError, WriteSnapshotError } from "./errors";
import { platformOf } from "./platform";

// 取余额结果:缺凭据(导入待补录)→ needs-credentials(跳过、不算失败);否则 ok{balances,totalUsd}。
// 由 app 注入的 fetchBalances 产出(内部先判 isComplete 再解密 + 调 provider.fetchBalances)。
// note 重设计(两级):balance 级单个 note 挂各 balance(随 balances 透传);account 级 note(Note[],整钱包)
// 放顶层 note 字段(BTC 未确认/收款/派生分布)。
export type FetchOutcome =
  | { status: "ok"; balances: Balance[]; totalUsd: number; note?: Note[] }
  | { status: "needs-credentials" };

// 退避重试参数(原则 #8:不硬编码散落)。
const RETRY_MAX_ATTEMPTS = 3; // 总尝试次数(1 + 2 重试)
const RETRY_BASE_MS = 200; // 指数退避基数
const RETRY_MAX_MS = 5000; // 单次退避上限(也用于 Retry-After 夹紧)
const SYNC_CONCURRENCY = 6; // 每用户账户取数的并发上限(CF subrequest / provider 限流留余量)
const FETCH_TIMEOUT_MS = 20_000; // 单次取数(单次尝试)超时上限

// 注入式 logger(最小接口,结构兼容 LogTape 的 Logger)。app 注入 getLogger(["folio","sync"]);
// 测试注入 no-op/捕获式 → 不耦合 LogTape、不污染输出。userId 由 syncAccount 显式带字段(cron 路径无请求上下文)。
export interface SyncLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}
// 没有注入 mint(或它抛错)时的空答案。共享一个不可变实例 —— 每账户新建一个空 Map 没有意义。
const EMPTY_IDS: ReadonlyMap<string, string> = new Map();

const noopLogger: SyncLogger = {
  debug() {},
  info() {},
  warning() {},
  error() {},
};

// 编排器对数据层【注入式依赖】:db 操作由调用方(server fn)绑好 env 后传入,
// 于是本包不连 D1、可用普通 vitest 测纯逻辑(解密 → 派发 → 隔离 → 汇总)。
// 真实数据访问仍只经 @folio/db(server fn 把其包装函数绑进来)。
export interface SyncDeps {
  listAccounts: (userId: string) => Promise<AccountSafe[]>;
  // 批量取该用户全部账户的 raw creds(一次查,syncUser 分发给各 syncAccount)—— 消除按账户的 N+1。
  listRawCreds: (userId: string) => Promise<AccountRawCreds[]>;
  writeSnapshot: (userId: string, accountId: string, input: WriteSnapshotInput) => Promise<string>;
  // 取余额(领域意图):app 注入 balances.fetchBalances —— 解密/校验/ctx 拼装/provider 调用全在其内。
  // 缺凭据返回 needs-credentials(跳过,不算失败);上游失败抛 ProviderError(本层据 retryable 重试)。
  fetchBalances: (account: AccountSafe, stored: Record<string, string>) => Promise<FetchOutcome>;
  log?: SyncLogger; // 默认 no-op;app 注入 LogTape logger(见 buildSyncDeps)
  // 认币(ADR 0021 / #200):一批 tokenRef → 各自的代币行 id。**跑在 revalue 之前、一轮同步只跑一次。**
  //
  // 为什么是独立一步而不是塞在 writeSnapshot 里(#200 当初那样):`revalue` 要按币问价,而新参考层的
  // `priceOf` 收 token_id —— 若 mint 留在写快照那头,revalue 就得自己再 mint 一遍,同一轮同步认两次
  // (两次结果还可能不一致,因为中间有别的账户在并发建行)。提到前面之后,认定这一轮只发生一次,
  // 下游两个消费者(revalue 定价、写快照落列)共用同一份答案。
  //
  // 返回 `tokenRef → tokenId`;认不出来的 ref 不出现在 map 里。best-effort:抛错当成空 map ——
  // 快照照落(新列留空)、价退回 provider 自带,认币故障不该让一轮同步丢数据。
  // @folio/sync 自己不依赖参考层,实现由 app 注入(它才是编排点)。
  mint?: (userId: string, balances: Balance[]) => Promise<Map<string, string>>;
  // 写快照前重估余额(P7.4.2 / Phase 3):app 注入 token 感知实现,按 per-user 估值模式定 value +
  // 捕获 selfPrice(估值原料)。userId 显式带 —— cron 路径共享一个 deps 跨多用户,模式按 userId 解析。
  // best-effort:抛错则保留 provider 原值,不让定价故障拖垮同步。@folio/sync 本身不依赖 token 层。
  // `idByRef` 由上一步的 mint 给出 —— 实现据它拿 token_id 去问价,不自己解析身份。
  revalue?: (
    userId: string,
    accountType: string,
    balances: Balance[],
    idByRef: ReadonlyMap<string, string>,
  ) => Promise<Balance[]>;
}

export interface AccountSyncResult {
  accountId: string;
  ok: boolean;
  skipped?: boolean; // 缺凭据态(导入待补录):跳过、不算失败(见 P6.6)
  snapshotId?: string;
  totalUsd?: number;
  error?: string;
}

export interface SyncResult {
  results: AccountSyncResult[];
}

// 取余额失败后的退避重试策略。**后台同步**用,没人在等 —— 所以宁可多等也不轻易放弃。
const retryPolicy = Schedule.exponential(Duration.millis(RETRY_BASE_MS)).pipe(
  // 只重试可重试的。**必须排在 passthrough 前**:它负责把输入类型钉成 FetchBalancesError,
  // 反过来写运行时正确但类型会塌成 unknown,下面就拿不到 retryAfterMs 了。
  Schedule.whileInput((e: FetchBalancesError) => e.retryable),
  // 把输出换成输入(错误本身),下一行才看得见 Retry-After。
  Schedule.passthrough,
  // 上游说了等多久就听它的,没说才用指数值;两者都夹在单次上限内 —— 夹住而不是放弃(clamp)。
  Schedule.modifyDelay((err, computed) =>
    Duration.min(
      Duration.millis(RETRY_MAX_MS),
      err.retryAfterMs !== undefined ? Duration.millis(err.retryAfterMs) : computed,
    ),
  ),
  // 抖动,防止 6 路并发同时撞 429 后又踩着同一个点一起醒来。
  // 用加性(+0~200ms)不是 Effect 自带的 jittered(乘性 0.8~1.2 倍)—— 后者会让退避短于基数,是行为改变。
  Schedule.addDelay(() => Duration.millis(Math.random() * RETRY_BASE_MS)),
  // 封顶重试 2 次(总尝试 3 次)。
  Schedule.intersect(Schedule.recurs(RETRY_MAX_ATTEMPTS - 1)),
);

// 取余额的单次尝试(带超时)。
function fetchOnce(
  deps: SyncDeps,
  account: AccountSafe,
  stored: Record<string, string>,
): Effect.Effect<FetchOutcome, FetchBalancesError> {
  // 注入的取数是个 Promise;抛出来的 provider 错误经桥转成 FetchBalancesError。
  return Effect.tryPromise({
    try: () => deps.fetchBalances(account, stored),
    catch: toFetchBalancesError,
  }).pipe(
    // 超时也产出 FetchBalancesError(retryable),这样重试策略只认识一种错误。
    // 用 timeoutFail 不用 Effect.timeout —— 后者会往错误通道塞一个 TimeoutException,
    // 和只认 FetchBalancesError 的策略类型对不上,编译期就红。
    // 注:只是停止等待,不真 abort 底层 fetch(CF 上 dangling fetch 随 isolate 回收)。
    Effect.timeoutFail({
      duration: Duration.millis(FETCH_TIMEOUT_MS),
      onTimeout: () =>
        new FetchBalancesError({
          message: "provider fetch timed out",
          code: "UPSTREAM_ERROR",
          retryable: true,
        }),
    }),
  );
}

// 取余额 + 退避重试。
function fetchWithRetry(
  deps: SyncDeps,
  account: AccountSafe,
  stored: Record<string, string>,
  log: SyncLogger,
  logCtx: Record<string, unknown>,
): Effect.Effect<FetchOutcome, FetchBalancesError> {
  let attempt = 0;
  const logged = retryPolicy.pipe(
    // 日志挂在 schedule 上而不是 tapError 上:它只在**决定再来一次**时触发,
    // 所以「不可重试」和「重试用尽」都不会多记一条 —— 与迁移前 onRetry 的时机一致。
    Schedule.tapOutput(([err]: readonly [FetchBalancesError, number]) =>
      Effect.sync(() => {
        attempt += 1;
        log.warning("provider call retrying", {
          ...logCtx,
          attempt,
          code: err.code,
          retryAfterMs: err.retryAfterMs,
        });
      }),
    ),
  );
  return fetchOnce(deps, account, stored).pipe(Effect.retry(logged));
}

// 单账户同步的 **Effect 内核**(ADR 0035)。错误通道是 never —— 失败已在内部收敛成 ok:false。
// 内核也导出是因为假时钟要 Effect 上下文,而 Promise 壳在包内部就把它 runPromise 掉了。
// 下一步出口改成 Effect 时,内核转正、壳删掉 —— 不是为测试开的临时缝。
export function syncAccountEffect(
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
  rawCreds: string | null, // 由 syncUser 批量预取分发(见 listRawCreds)
): Effect.Effect<AccountSyncResult> {
  const log = deps.log ?? noopLogger;
  // 安全字段(红线:绝不打 creds/secret/地址);userId 显式带,覆盖 cron 路径(无请求级 withContext)。
  const ctxFields = { userId, accountId: account.id, connectorId: account.connectorId };
  return Effect.gen(function* () {
    // 坏 JSON 也算这个账户的失败(与迁移前一致:原先由最外层 try/catch 收)。
    const stored = yield* Effect.try({
      try: (): Record<string, string> => (rawCreds ? JSON.parse(rawCreds) : {}),
      catch: (e) => new FetchBalancesError({ message: messageOf(e), retryable: false, cause: e }),
    });
    // 取余额(解密/校验/ctx/provider 调用全在注入的 fetchBalances 内)。仅取数部分重试(写快照不重试);
    // 每次尝试加超时(挂住的 provider → 超时 → 按 retryable 重试),避免内联 triggerSync 被拖住。
    const outcome = yield* fetchWithRetry(deps, account, stored, log, ctxFields);
    // 缺凭据态(导入待补录)→ 跳过,不算失败,补录后下次纳入(见 P6.6.1)。
    // **仍是正常返回值、不进错误通道** —— 它不是出事了,是这轮没事干(见 ADR 0035)。
    if (outcome.status === "needs-credentials") {
      log.warning("account sync skipped: needs credentials", ctxFields);
      return { accountId: account.id, ok: false, skipped: true } satisfies AccountSyncResult;
    }
    // 取余额之后的几步(认币 / 重估 / 写快照)本步先整体包着复用原有逻辑,
    // **下一步(#365)拆成原生 Effect** —— 本步只动重试与超时,便于逐片验证行为等价。
    return yield* Effect.tryPromise({
      try: () => finishAccountSync(deps, userId, account, outcome, log, ctxFields),
      catch: (e) => new WriteSnapshotError({ message: messageOf(e), cause: e }),
    });
  }).pipe(
    // 整体隔离:失败收成 ok:false,绝不抛(不阻断其他账户)。
    Effect.catchAll((err) =>
      Effect.sync((): AccountSyncResult => {
        const error = err.message;
        log.error("account sync failed", {
          ...ctxFields,
          code: err._tag === "FetchBalancesError" ? err.code : undefined,
          error,
        });
        return { accountId: account.id, ok: false, error };
      }),
    ),
  );
}

// 取余额之后的三步(认币 → 重估 → 写快照)。**临时形态**:本步保持原有 async 实现,
// 下一步(#365)整体拆成原生 Effect。抛错由调用方收敛成 ok:false,与迁移前一致。
async function finishAccountSync(
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
  outcome: Extract<FetchOutcome, { status: "ok" }>,
  log: SyncLogger,
  ctxFields: Record<string, unknown>,
): Promise<AccountSyncResult> {
  {
    let { balances, totalUsd } = outcome;

    // 认币(ADR 0021 / #200):**先于 revalue**,一轮同步只跑一次。见 SyncDeps.mint 的注释。
    // best-effort:失败当空 map —— 快照照落(新列留空)、价退回 provider 自带。
    let idByRef: ReadonlyMap<string, string> = EMPTY_IDS;
    if (deps.mint) {
      try {
        idByRef = await deps.mint(userId, balances);
      } catch (e) {
        log.warning("mint failed; writing snapshot without token_id", {
          ...ctxFields,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 重估(P7.4.2):manual 用市场价改 usdValue,再重算 totalUsd。best-effort —— 失败保留 provider 原值。
    if (deps.revalue) {
      try {
        balances = await deps.revalue(userId, account.connectorId, balances, idByRef);
        totalUsd = balances.reduce((sum, b) => sum + b.value, 0);
      } catch (e) {
        log.warning("revalue failed; keeping provider values", {
          ...ctxFields,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const snapshotId = await deps.writeSnapshot(userId, account.id, {
      takenAt: Date.now(),
      totalUsd,
      // account 级 note(Note[],整钱包)落 snapshots.note;revalue 不动它。
      note: outcome.note,
      // 边界映射:Balance 契约用 value,快照层沿用 usdValue(不动表结构)。其余字段透传;
      // token 元信息(name/logo/tokenRef)不落快照,参考层是其 home(见 canonical 计划)。
      // kind 透传:db 的 SnapshotBalanceInput.kind 与 connectors Balance 同为 4-kind 联合
      //(spot/defi/perp_equity/perp_position,#37c 起 db 直取 @folio/connectors-basic;utxo 已并回 spot,ADR 0010),直接透传。
      // balance 级 note(单个 Note,note 重设计)随各 balance 落 snapshot_balances.note;revalue 不动 note。
      // meta 仅 defi/perp 有(spot 零 typed meta)→ 用 `in` 收窄后取。
      balances: balances.map((b) => ({
        amount: b.amount,
        usdValue: b.value,
        kind: b.kind,
        // 平台(链 ∪ 场馆)在这里算一次、落库(#193):写路径是唯一还认识 tokenRef 的地方,
        // 读端从此只读这一列。规则见 platformOf。
        platform: platformOf(b.tokenRef, account.connectorId),
        // provider 自带单价(估值原料,Phase 3):revalue 捕获,随快照落 self_price。
        selfPrice: b.selfPrice,
        // 认定冻进快照:用的就是 revalue 定价时那一份答案(同一轮只 mint 一次)。symbol / tokenRef
        // 不再落快照 —— 显示名住 Token 那一行,读端按 token_id 取(#243)。
        tokenId: b.tokenRef ? idByRef.get(b.tokenRef) : undefined,
        meta: "meta" in b ? b.meta : undefined,
        note: b.note,
      })),
    });
    log.info("account synced", { ...ctxFields, totalUsd, balances: balances.length });
    return { accountId: account.id, ok: true, snapshotId, totalUsd };
  }
}

// Promise 壳(见 syncAccountEffect 的注释:下一步删壳、内核转正)。
export function syncAccount(
  deps: SyncDeps,
  userId: string,
  account: AccountSafe,
  rawCreds: string | null,
): Promise<AccountSyncResult> {
  return Effect.runPromise(syncAccountEffect(deps, userId, account, rawCreds));
}

// 同步该用户全部账户,逐账户隔离、有界并发汇总。account/creds 各一次批量读(消 N+1),再分发。
// 并发调度本步仍走手写 runPool(下一步 #366 换成 Effect 的并发原语)。
export function syncUserEffect(deps: SyncDeps, userId: string): Effect.Effect<SyncResult> {
  return Effect.gen(function* () {
    // 账户与凭据各一次批量读(消 N+1),两次互不依赖 → 并发取。
    const [accounts, rawList] = yield* Effect.all(
      [
        Effect.promise(() => deps.listAccounts(userId)),
        Effect.promise(() => deps.listRawCreds(userId)),
      ],
      { concurrency: 2 },
    );
    const credsById = new Map(rawList.map((r) => [r.id, r.creds]));
    // 有界并发。**必须留在同一个 Effect 里** —— 中间夹一层 runPromise 会切断上下文,
    // 假时钟就推不动各账户内部的退避了(测试挂不上)。这也是手写 runPool 一并换掉的原因。
    const results = yield* Effect.forEach(
      accounts,
      (account) => syncAccountEffect(deps, userId, account, credsById.get(account.id) ?? null),
      { concurrency: SYNC_CONCURRENCY },
    );
    return { results };
  });
}

// Promise 壳。
export function syncUser(deps: SyncDeps, userId: string): Promise<SyncResult> {
  return Effect.runPromise(syncUserEffect(deps, userId));
}

export interface SweepResult {
  users: number;
  ok: number; // 成功账户数
  failed: number; // 失败账户数
  skipped: number; // 缺凭据跳过数(待补录,见 P6.6)
}

// 定时同步全量 sweep(P6.3):逐用户调 syncUser,逐用户 try/catch 隔离(一个用户炸不影响其余;
// syncUser 内部已逐账户隔离)。失败经注入 logger 记构化日志(每账户失败已在 syncAccount 记,这里只兜底用户级抛错)。
export async function syncAllUsers(deps: SyncDeps, userIds: string[]): Promise<SweepResult> {
  const log = deps.log ?? noopLogger;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  for (const userId of userIds) {
    try {
      const { results } = await syncUser(deps, userId);
      for (const r of results) {
        if (r.ok) ok++;
        else if (r.skipped)
          skipped++; // 缺凭据:不算失败
        else failed++; // 具体错误已在 syncAccount 以 error 级记录
      }
    } catch (err) {
      // syncUser 理论上不抛(整体兜底),此处仅防御:整个用户失败也不中断 sweep。
      failed++;
      log.error("user sweep threw", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { users: userIds.length, ok, failed, skipped };
}
