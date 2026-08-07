import type { Balance, ConnectorError, Note } from "@folio/connectors-basic";
import type { AccountRawCreds, AccountSafe, WriteSnapshotInput } from "@folio/db";
import type { Effect } from "effect";

// 本包与外界的公开类型:注入什么、吐出什么。实现分散在 services / account / sweep,
// 但类型全在这一处 —— 想知道「用这个包要准备什么」看这个文件就够。

// 取余额结果:缺凭据(导入待补录)→ needs-credentials(跳过、不算失败);否则 ok{balances,totalUsd}。
// 由 app 注入的 fetchBalances 产出(内部先判 isComplete 再解密 + 调 provider.fetchBalances)。
// note 重设计(两级):balance 级单个 note 挂各 balance(随 balances 透传);account 级 note(Note[],整钱包)
// 放顶层 note 字段(BTC 未确认/收款/派生分布)。
export type FetchOutcome =
  | { status: "ok"; balances: Balance[]; totalUsd: number; note?: Note[] }
  | { status: "needs-credentials" };

export type OkOutcome = Extract<FetchOutcome, { status: "ok" }>;

// 注入式 logger(最小接口,结构兼容 LogTape 的 Logger)。app 注入 getLogger(["folio","sync"]);
// 测试注入 no-op/捕获式 → 不耦合 LogTape、不污染输出。
//
// **这是公开契约,不是内部写法**:包内业务代码一律用 Effect 自带的日志,`services.ts` 把它转发到
// 这里注入的实现(见 forwardTo)。于是「这条日志带哪些上下文字段」是标注出来的、自动往下渗透的,
// 不必逐层手传 —— 而 app 侧仍然只需要交一个 LogTape logger,什么都不用懂。
export interface SyncLogger {
  debug(message: string, properties?: Record<string, unknown>): void;
  info(message: string, properties?: Record<string, unknown>): void;
  warning(message: string, properties?: Record<string, unknown>): void;
  error(message: string, properties?: Record<string, unknown>): void;
}

// 编排器对数据层的【注入式依赖】:db 操作由调用方(server fn)绑好 env 后传入,
// 于是本包不连 D1、可用普通 vitest 测纯逻辑。真实数据访问仍只经 @folio/db。
//
// 这是**公开形状**(Promise 进 Promise 出)。包内部不直接用它 —— `services.ts` 把它翻译成
// 一组 Effect 服务,业务代码只认识那些服务。下一步(出口改成 Effect)这层翻译删掉,
// 调用方直接提供服务。
export interface SyncDeps {
  listAccounts: (userId: string) => Promise<AccountSafe[]>;
  // 批量取该用户全部账户的 raw creds(一次查,再分发给各账户)—— 消除按账户的 N+1。
  listRawCreds: (userId: string) => Promise<AccountRawCreds[]>;
  writeSnapshot: (userId: string, accountId: string, input: WriteSnapshotInput) => Promise<string>;
  // 取余额(领域意图):app 注入 connectors 的取数 —— 解密/校验/ctx 拼装/provider 调用全在其内。
  // 缺凭据返回 needs-credentials(跳过,不算失败);上游失败抛 ProviderError(本层据 retryable 重试)。
  // **这一个是 Effect,其余五个仍是 Promise。** 不是不一致 —— 取余额是唯一会驱动决策的那步
  // (重不重试、等多久),而那些决策必须发生在同一个 Effect 里:中途转一次 Promise 就切断了
  // context,外层的超时和中断管不到 provider 内部(sync 迁移时实测过)。其余五步是一次性的
  // 数据库调用,包一层 `tryPromise` 不丢任何东西。
  fetchBalances: (
    account: AccountSafe,
    stored: Record<string, string>,
  ) => Effect.Effect<FetchOutcome, ConnectorError>;
  log?: SyncLogger; // 默认 no-op;app 注入 LogTape logger(见 buildSyncDeps)
  // 认币(ADR 0021 / #200):一批 tokenRef → 各自的代币行 id。**跑在 revalue 之前、一轮同步只跑一次。**
  //
  // 为什么是独立一步而不是塞在 writeSnapshot 里(#200 当初那样):`revalue` 要按币问价,而新参考层的
  // `priceOf` 收 token_id —— 若 mint 留在写快照那头,revalue 就得自己再 mint 一遍,同一轮同步认两次
  // (两次结果还可能不一致,因为中间有别的账户在并发建行)。提到前面之后,认定这一轮只发生一次,
  // 下游两个消费者(revalue 定价、写快照落列)共用同一份答案。
  //
  // 返回 `tokenRef → tokenId`;认不出来的 ref 不出现在 map 里。best-effort:失败当成空 map ——
  // 快照照落(新列留空)、价退回 provider 自带,认币故障不该让一轮同步丢数据。
  // 不注入 = 整条路照跑、token_id 留空。
  mint?: (userId: string, balances: Balance[]) => Promise<Map<string, string>>;
  // 写快照前重估余额(P7.4.2 / Phase 3):app 注入 token 感知实现,按 per-user 估值模式定 value +
  // 捕获 selfPrice(估值原料)。userId 显式带 —— cron 路径共享一份依赖跨多用户,模式按 userId 解析。
  // best-effort:失败则保留 provider 原值。`idByRef` 由上一步的 mint 给出。
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

export interface SweepResult {
  users: number;
  ok: number; // 成功账户数
  failed: number; // 失败账户数
  skipped: number; // 缺凭据跳过数(待补录,见 P6.6)
}
