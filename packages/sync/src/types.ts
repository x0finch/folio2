import type { Balance, Note } from "@folio/connectors-basic";

// 本包与外界的公开类型:吐出什么。实现分散在 services / account / sweep,但类型全在这一处。
//
// 「注入什么」那一半没了(#403 片 3):调用方不再交一个 `SyncDeps` 对象,而是直接提供
// `SyncServices` —— 那组能力的形状写在 services.ts 的 Tag 上,类型即契约,不必在这里抄一遍。

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

/**
 * 为什么跳过 —— 跳过不是失败,是「这轮没事干」,但**没事干的两个原因该分开**(#527 裁定 2)。
 *
 * `manual`:这个账户根本没有上游(手记账户,ADR 0018),永远如此,用户不必管。
 * `missing-credentials`:凭据没填完,填完下次就纳入 —— 该提示他去填。
 *
 * 以前两者返回一模一样的 `{ ok: false, skipped: true }`,于是界面上都只能显示成「跳过了」,
 * 而「跳过了」对第二种情况是一句废话:唯一的下一步动作恰恰没有说出来。
 */
export type SyncSkipReason = "manual" | "missing-credentials";

export interface AccountSyncResult {
  accountId: string;
  ok: boolean;
  skipped?: boolean; // 跳过、不算失败(见 P6.6)
  /** 只在 `skipped` 为真时出现。**与 `error` 各归各的**:那个说失败,这个说没事干。 */
  skipReason?: SyncSkipReason;
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
