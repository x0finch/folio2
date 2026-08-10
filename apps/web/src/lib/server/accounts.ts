import type { ConnectorId } from "@folio/connectors";
import { AccountStore, PortfolioStore } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { z } from "zod";
import { isComplete, safeView } from "../creds";
import { loadAccountHistory } from "./internal/account-history";
import { credentialSpecs, validateAccountCreds } from "./internal/connector-registry";
import { createAccountFor, raw2sealed } from "./internal/create-account";
import { sealManualAccount } from "./internal/manual";
import { runRequest, runStore } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";

// userId 经 requireAuth 的 withContext 自动带入(ALS);各处只记 connectorId/accountId 等安全字段(红线:不打 creds)。
const log = getLogger(["folio", "web", "accounts"]);

// 富化:把每账户的 raw creds 投影成 needsCredentials + credsSafe(public 原样、semi 打码、secret 丢弃);
// raw creds(含 secret 密文)绝不出网,只出投影。
export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [accounts, rawList] = await runStore(context.userId, AccountStore, (s) =>
      Effect.all([s.list(), s.listRawCreds()], { concurrency: 2 }),
    );
    const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
    const specsByType = credentialSpecs();
    return accounts.map((a) => {
      const raw = rawById.get(a.id);
      const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
      const specs = specsByType[a.connectorId] ?? [];
      return {
        ...a,
        needsCredentials: !isComplete(specs, stored),
        credsSafe: safeView(specs, stored),
      };
    });
  });

// 统一创建入口(connector-driven,#55/#52):auth 薄壳 → 分派逻辑在 ./create-account 的 createAccountFor
// (server fn 之外的纯 async,便于集成测试)。
const CreateAccountInput = z.object({
  connectorId: z.string().min(1),
  label: z.string().trim().min(1, "label is required"),
  values: z.record(z.string(), z.string().trim()), // 表单原始输入(键 = connector.account.creds 的 key);trim 后落库
  // 落在当前选中的 Portfolio(ADR 0033);缺省 → 服务端本就落默认 Portfolio。
  portfolioId: z.string().min(1).optional(),
});
export const createAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateAccountInput)
  .handler(async ({ data, context }) => {
    return runRequest(
      context.userId,
      Effect.gen(function* () {
        const account = yield* createAccountFor(
          data.connectorId as ConnectorId,
          data.label,
          data.values,
        );
        // createAccountFor 已把账户落进默认 Portfolio;若指定了非默认的选中,改归属过去。
        if (data.portfolioId) {
          yield* Effect.flatMap(PortfolioStore, (s) =>
            s.assignAccount(account.id, data.portfolioId as string),
          );
        }
        return account;
      }),
    );
  });

// 凭据再水合(P6.6.1):为导入的"缺凭据"账户补录真值。活性校验通过后整张 map 覆盖(占位被真值替换)。
const ReplaceCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string().trim()), // seal 原始输入 → 值先 trim
});
export const replaceAccountCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ReplaceCredentialsInput)
  .handler(async ({ data, context }) => {
    const account = await runStore(context.userId, AccountStore, (s) => s.getById(data.accountId));
    if (!account) throw new Error("account not found");
    // 校验(含活性探活)不碰 db,留在边缘 —— 它失败时的那条消息要原样给到表单上。
    await validateAccountCreds(account.connectorId, data.creds, {
      liveness: true,
      label: account.label,
    });
    const sealed = await raw2sealed(account.connectorId, data.creds);
    await runStore(context.userId, AccountStore, (s) => s.setCredentials(account.id, sealed));
    log.info("credentials provided", { connectorId: account.connectorId, accountId: account.id });
    return { ok: true as const };
  });

// —— 单账户管理(部分更新 / 删除)——
// db 层按 (id, userId) 作用域,天然杜绝越权;不存在则影响 0 行(静默),不额外抛。

const AccountIdInput = z.object({ accountId: z.string().min(1) });

// 部分更新:重命名 和/或 归档切换(按传入字段各自生效)。归档可逆、数据保留;归档后不计总额、不参与同步。
//
// **归档 = 封存(ADR 0039),对 manual 账户它是一次写。** manual 从不写快照(ADR 0018),归档之后
// 库里没有任何可展示的照片 —— 所以先按账本算一次、落一张真快照,**成功了才**打归档标记。
//
// **顺序不可颠倒,这不是风格问题:**
//   · D1 没有交互式事务,而这两条写分属快照与账户两个 store,没有共同的 batch 边界;
//   · 按这个顺序,最坏情况是留下一张孤儿快照 —— 无害,只是账户历史里多一个真实数据点,
//     而且下次归档成功会再写一张更新的;
//   · 反过来,最坏情况是「已归档但没有照片」—— 正好是这次要消灭的那个状态。
// 为此**不**在 `@folio/db` 里开跨两张表的合并 op:为一个低频动作在契约层捅个口子,不划算。
//
// 封存那一步要用参考层(取现价),所以整段从 `runStore` 换成 `runRequest`。
export const updateAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    AccountIdInput.extend({
      label: z.string().trim().min(1, "label is required").optional(),
      archived: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const sealed = await runRequest(
      context.userId,
      Effect.gen(function* () {
        const accounts = yield* AccountStore;
        if (data.label !== undefined) yield* accounts.rename(data.accountId, data.label);
        let sealed = false;
        if (data.archived === true) {
          // 取的是**还没打标记**的那一行 —— 封存那条路按「未归档」过滤,顺序反了会一无所获。
          const account = yield* accounts.getById(data.accountId);
          // **已经归档的不再动它**(review 补):对已归档账户再发一次 `archived: true`,封存那步会
          // 被「未归档」这道过滤挡掉、什么都不落,而 `setArchived` 却会把 `archivedAt` 重写成当刻 ——
          // 结果是封存时刻往前跳、数据还停在旧那张:曲线的截断点、抽屉曲线的窗口锚都跟着挪,
          // 而它们描述的那份数据一点没变。UI 那颗按钮是切换、触发不到这条,但 server fn 收得下。
          if (account?.archivedAt == null) {
            if (account) sealed = yield* sealManualAccount(account);
            yield* accounts.setArchived(data.accountId, true);
          }
        } else if (data.archived === false) {
          yield* accounts.setArchived(data.accountId, false);
        }
        return sealed;
      }),
    );
    log.info("account updated", {
      accountId: data.accountId,
      renamed: data.label !== undefined,
      archived: data.archived,
      sealed,
    });
    return { ok: true as const };
  });

// 删除:不可逆(snapshots/manual_activity 经 ON DELETE CASCADE 级联清)。前端需二次确认。
export const removeAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountIdInput)
  .handler(async ({ data, context }) => {
    await runStore(context.userId, AccountStore, (s) => s.remove(data.accountId));
    log.info("account deleted", { accountId: data.accountId });
    return { ok: true as const };
  });

// 单账户价值历史(A2 抽屉头部 chart):该账户全部快照 (takenAt, totalUsd) → 升序序列,since 裁窗口。
// listSnapshotsByAccount 内含 assertAccountOwned(越权即抛)。过去点与末点均用冻结 usd_value ——
// 账户页/抽屉头 account.totalUsd 亦为冻结最新快照总额,故曲线当下点 ≡ 头部数值,无需 live 覆写。
// manual 账户不写快照(ADR 0018)→ 走账本 compute-on-read(日网格,ADR 0019):过去点由账本折叠 + oracle 历史价,
// **末点补一个「当下」实时盯市点** → 端点与抽屉头 account.totalUsd 同源。connectorId 由客户端传入做读路径分流;
// 缺省/非 manual → 快照路径。since/降采样两路复用。
export const getAccountHistory = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator(
    z.object({
      accountId: z.string().min(1),
      since: z.number().int().nonnegative().optional(),
      connectorId: z.string().optional(),
    }),
  )
  .handler(({ data, context }) => runRequest(context.userId, loadAccountHistory(data)));
