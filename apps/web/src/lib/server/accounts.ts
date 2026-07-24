import type { ConnectorId } from "@folio/connectors";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isComplete, safeView } from "../creds";
import { buildAccountValueHistory } from "../history";
import { MANUAL_CONNECTOR_ID } from "../manual-connector";
import { requireAuth } from "../require-auth";
import { credentialSpecs, validateAccountCreds } from "./internal/connector-registry";
import { createAccountFor, raw2sealed } from "./internal/create-account";
import { db } from "./internal/db";
import { loadManualAccountLiveTotal, loadManualAccountSeries } from "./internal/manual";

// userId 经 requireAuth 的 withContext 自动带入(ALS);各处只记 connectorId/accountId 等安全字段(红线:不打 creds)。
const log = getLogger(["folio", "web", "accounts"]);

// 富化:把每账户的 raw creds 投影成 needsCredentials + credsSafe(public 原样、semi 打码、secret 丢弃);
// raw creds(含 secret 密文)绝不出网,只出投影。
export const listAccounts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const [accounts, rawList] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.listRawCredsByUser(context.userId),
    ]);
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
});
export const createAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(CreateAccountInput)
  .handler(({ data, context }) =>
    createAccountFor(context.userId, data.connectorId as ConnectorId, data.label, data.values),
  );

// 凭据再水合(P6.6.1):为导入的"缺凭据"账户补录真值。活性校验通过后整张 map 覆盖(占位被真值替换)。
const ReplaceCredentialsInput = z.object({
  accountId: z.string().min(1),
  creds: z.record(z.string(), z.string().trim()), // seal 原始输入 → 值先 trim
});
export const replaceAccountCredentials = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(ReplaceCredentialsInput)
  .handler(async ({ data, context }) => {
    const account = await db.getAccountById(context.userId, data.accountId);
    if (!account) throw new Error("account not found");
    await validateAccountCreds(account.connectorId, data.creds, {
      liveness: true,
      label: account.label,
    });
    await db.setAccountCredentials(
      context.userId,
      account.id,
      await raw2sealed(account.connectorId, data.creds),
    );
    log.info("credentials provided", { connectorId: account.connectorId, accountId: account.id });
    return { ok: true as const };
  });

// —— 单账户管理(部分更新 / 删除)——
// db 层按 (id, userId) 作用域,天然杜绝越权;不存在则影响 0 行(静默),不额外抛。

const AccountIdInput = z.object({ accountId: z.string().min(1) });

// 部分更新:重命名 和/或 归档切换(按传入字段各自生效)。归档可逆、数据保留;归档后不计总额、不参与同步。
export const updateAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    AccountIdInput.extend({
      label: z.string().trim().min(1, "label is required").optional(),
      archived: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    if (data.label !== undefined) {
      await db.renameAccount(context.userId, data.accountId, data.label);
    }
    if (data.archived !== undefined) {
      await db.setArchived(context.userId, data.accountId, data.archived);
    }
    log.info("account updated", {
      accountId: data.accountId,
      renamed: data.label !== undefined,
      archived: data.archived,
    });
    return { ok: true as const };
  });

// 删除:不可逆(snapshots/accountGroups/manual_activity 经 ON DELETE CASCADE 级联清)。前端需二次确认。
export const removeAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(AccountIdInput)
  .handler(async ({ data, context }) => {
    await db.deleteAccount(context.userId, data.accountId);
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
  .handler(async ({ data, context }) => {
    if (data.connectorId === MANUAL_CONNECTOR_ID) {
      // 日网格 compute-on-read(ADR 0019):同一 now 喂网格(末点 τ=now)与 live 末点 → 端点同刻,replace 分支命中。
      const now = Date.now();
      const rows = await loadManualAccountSeries(context.userId, data.accountId, now);
      const series = buildAccountValueHistory(
        rows.map((r) => ({ takenAt: r.takenAt, totalUsd: r.totalUsd })),
        data.since,
      );
      // 末点接实时盯市(与抽屉头同源):有账本点才补,空账户不凭空造点(与快照路径空态一致)。
      const liveTotal = await loadManualAccountLiveTotal(context.userId, data.accountId);
      if (liveTotal != null && series.length > 0) {
        const last = series[series.length - 1];
        if (last.t >= now) series[series.length - 1] = { t: last.t, total: liveTotal };
        else series.push({ t: now, total: liveTotal });
      }
      return { series };
    }
    const snapshots = await db.listSnapshotsByAccount(context.userId, data.accountId);
    return { series: buildAccountValueHistory(snapshots, data.since) };
  });
